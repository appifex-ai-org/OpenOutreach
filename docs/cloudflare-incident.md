# Cloudflare deploy — open platform issue (2026-10-05)

Status: **the multi-tenant engine is complete and verified locally end to end;
production containers are blocked by a Cloudflare platform behavior, under
investigation.** This file is the evidence trail and the support-case text.
The full engineering postmortem — including the two bugs found in our code and
the elimination matrix that isolates the platform issue — is
[cloudflare-findings.md](cloudflare-findings.md).

## What works (verified)

- The engine image (`deploy/cloudflare/Dockerfile`, openoutreach 0.1.60) runs
  correctly locally on **linux/arm64 and linux/amd64**, as root and non-root
  (uid 65532), under a **4 GiB memory cap**: state restore → migrate → shim on
  :8080 → ingest (idempotent, malformed-line contract) → CRM reads → send
  protocol (`--agent-draft`, typed errors naming missing `OUTSEND_*`) → R2
  sync round-trip → restart restore (mock state store).
- The Worker's HTTP surface, service-token auth, per-workspace DO config
  storage, and R2-served `/db` all work in production.
- A `sleep 900` container with a per-start entrypoint override ran **15
  minutes** in production (2026-10-04 ~23:52, app `a033a7dc…`).

## Real bugs found and fixed in our code (keep these)

1. **DO-eviction activity kill.** The `@cloudflare/containers` SDK keeps the
   activity deadline (`sleepAfterMs`) only in Durable Object memory. After the
   DO is evicted — which can happen within the 1s startup alarm — the field
   resets to 0, `isActivityExpired()` is instantly true, and the default
   `onActivityExpired()` stops a healthy container seconds after start.
   Fix: `OutreachContainer.onActivityExpired()` derives liveness from the
   persisted `getState().lastChange` and re-arms instead of stopping.
2. **Fragile boot.** `container-start` now: never lets migrate kill the
   container, supervises the shim with restart-on-crash, writes a boot
   transcript uploaded to R2 per step, and never uses process substitution.

## The open issue

Every container that runs the real entrypoint **stops within ~1–2 seconds of
its first steps**, across:

- two container applications (the original `a03a3cce…` and a clean-room
  `a03dc251…` created 2026-10-05 with a fresh Worker name), after full
  provisioning waits;
- images: wrangler-built (digest-pinned), manually built and pushed
  (`registry.cloudflare.com/…/openoutreach-engine:v2/v3`, amd64), and a
  **public base image** (`docker.io/library/python:3.12-slim-bookworm`);
- with and without outbound interception (`outboundByHost` + `ContainerProxy`);
- with the entrypoint from the image and passed explicitly at start.

Observations that constrain the cause:

- With interception on, the container's `state.internal` requests **do reach
  the Worker's outbound handler** (three `PUT …/boot.log` and one `GET
  …/db.sqlite3` logged, all answered) — then the container stops before the
  shim binds :8080, and `waitForPort` reports "Container crashed while
  checking for ports".
- Objects PUT by the outbound handler (`env.CRM.put(request.body)`) **do not
  appear in the bucket**, although the same bucket round-trips fine via
  `wrangler r2 object put/get --remote`.
- A heartbeat loop curling the Worker's public URL from inside the container
  **never arrives** — public egress from containers appears dead, while
  intercepted (port 80) traffic works.
- The identical Worker code + interception ran in production on 2026-09-29
  (single-tenant version): containers ran the find job, and the state sync
  uploaded a real `db.sqlite3` that was downloaded from the bucket.

The last data point suggests a **platform-side regression between 2026-09-29
and 2026-10-04** in the container networking/data path for this account.

## Support-case summary (file against account 5db6a7cf9dc844657c4b9ce8eb7da202)

> Containers application `openoutreach-engine-outreachcontainer`
> (a03dc251-4a96-4abf-b586-0e9090962d62), Worker `openoutreach-engine`
> (openoutreach-engine.appifex-ai.workers.dev). Since 2026-10-04, every
> container running a real entrypoint stops within ~1–2s of start ("Container
> crashed while checking for ports"), while a bare `sleep 900` entrypoint runs
> 15 minutes. During the short life, the container's outbound HTTP through the
> interception proxy reaches the Worker's outboundByHost handler, but (a) the
> handler's R2 puts never persist, and (b) public egress from the container
> (HTTPS to the Worker's own URL) never arrives. The same code ran correctly
> on 2026-09-29 (single-tenant Worker `openoutreach`, then-app
> a03a3cce-67ed-47fd-a2dc-16ddf5d1f0d6). Image: amd64, standard-1,
> python:3.12-slim base + pip-installed package. Reproduce: `PUT /w/<ws>/config`
> then `POST /w/<ws>/check` with the service token; watch `wrangler tail` and
> `wrangler containers instances`.

## Interim options if the platform issue persists

1. **rclone/S3 fallback for state** (designed, not wired): R2 API tokens +
   `rclone` in the image replace `state.internal`; the shim's `r2_get/r2_put`
   switch to S3 endpoints. Removes the interception dependency but not the
   container-death issue.
2. **Host on a VM** (`docs/docker.md` deploy) behind Cloudflare Tunnel — the
   engine is a standard Docker workload; the Cloudflare-specific value (scale
   to zero) is what's lost.
3. Wait out what may be a platform incident; re-run the E2E script
> (`POST /w/<ws>/check`) before any of the above.
