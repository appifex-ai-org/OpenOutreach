# Cloudflare multi-tenant engine — engineering findings (2026-10-04/05)

This is the postmortem of the multi-tenant engine build session: what was
built and verified, two real bugs found in our code (with root-cause
analysis), the hardening lessons, and the platform-side issue that currently
blocks production — including the full elimination matrix that isolates it.
Operational summary and the support-case text live in
[cloudflare-incident.md](cloudflare-incident.md); the engine's contract is
[cloudflare.md](cloudflare.md).

## 1. What was built

Scope (per the voki integration decision): **send + CRM only**. The engine
ingests leads through the public JSON-Lines contract, sends mail with the
caller's openers (`--agent-draft`), and serves the sender's tables as CRM
reads. No discovery, no BetterContact key, no LLM key.

| Component | File | Role |
|---|---|---|
| Engine shim | `deploy/cloudflare/shim.py` | `/ingest` `/send` `/draft` `/check` `/pending` + `/crm/*` reads; the `draft_pending` protocol as request/response; R2 state sync after every change |
| Entrypoint | `deploy/cloudflare/container-start` | restore from R2 → migrate (non-fatal) → supervised shim; per-step boot transcript to R2 |
| Worker | `deploy/cloudflare/src/index.ts` | per-workspace named DO instances (the mutex), config in DO storage applied as container env, service-token auth, R2-served `/db` |
| Image | `deploy/cloudflare/Dockerfile` | openoutreach 0.1.60 from PyPI, non-root, port 8080 |

### Verified locally (all passing)

- **linux/arm64 and linux/amd64** builds of the image: restore → migrate →
  shim → ingest → CRM → send protocol → R2 sync → **restart restore** (leads
  survive), against a mock of the outbound state store.
- Non-root execution (uid 65532, not the image user).
- **4 GiB memory cap** on migrate (OOM ruled out).
- Ingest contract exactness: `stored 2 lead(s)`, malformed line skipped and
  counted, non-zero exit with rows still stored.
- Draft protocol: `/draft` without a pending draft → 409; typed errors naming
  missing `OUTSEND_*` variables surface through `/pending`.
- The Worker surface in production: auth (401/200), config RPC, `/db` from R2.

## 2. Bug #1 — the SDK's DO-eviction activity kill (fixed, keep the workaround)

**Symptom:** healthy containers stopped within seconds of starting — including
a bare `sleep 900` — with `waitForPort` reporting
*"Container crashed while checking for ports"*.

**Root cause:** `@cloudflare/containers` (0.3.7) keeps the activity deadline in
Durable Object memory only:

```js
renewActivityTimeout() { this.sleepAfterMs = Date.now() + parseTimeExpression(this.sleepAfter) * 1000; }
isActivityExpired()    { return this.sleepAfterMs <= Date.now(); }   // class field default: 0
```

After the DO that started a container is **evicted** — which can happen within
the 1-second startup alarm — the field resets to `0`. The alarm fires in a
fresh DO instance, `isActivityExpired()` is instantly true, and the default
`onActivityExpired()` calls `stop()` on a perfectly healthy container.

**Why the single-tenant deploy never saw it:** its `/run` handler held the DO
through a longer request path, so the 1s alarm usually landed in the same
in-memory instance. The multi-tenant RPC path returns faster; eviction wins
the race.

**Fix** (`OutreachContainer.onActivityExpired` in `src/index.ts`): derive
liveness from *persisted* state — only stop once `getState().lastChange` is
older than the sleep window; otherwise re-arm the alarm. Confirmed by
observation: after the fix, a `sleep 900` instance ran its full 15 minutes.

**Upstream:** worth reporting to `cloudflare/workers-sdk` — the SDK should
persist the deadline (or derive it) so an eviction can't reset it. Our
override stays even when fixed upstream; it is harmless and explicit.

## 3. Bug #2 — `start()` scheduling race (fixed)

**Symptom:** intermittent *"Failed to start container: The container just
exited"* / hangs of ~120 s on first workspace use.

**Root cause:** `Container.start()` issues `this.container.start(config)`
(fire-and-forget), then immediately health-fetches the port. If the instance
is still scheduling, `running` is false at that instant and the error path
falls into `await this.monitor.catch(...)` — a promise that only settles when
the container eventually *stops*. `start()` hangs until then.

**Fix:** `ensureStarted()` uses `startAndWaitForPorts` with an explicit budget
(`portReadyTimeoutMS: 90_000`, `waitInterval: 1_000`) — the documented
cold-boot-tolerant path. Cold boots legitimately take tens of seconds (state
restore + Django migrate on ½ vCPU) before :8080 answers.

## 4. Hardening lessons (in `container-start` now)

- **No process substitution** (`exec > >(tee …)`): died instantly on the
  platform, fine everywhere locally. Plain file redirection only.
- **Never let diagnostics kill boot:** the boot transcript is a file uploaded
  with a bounded `curl --max-time 5`; `log()` writes can't fail the script.
- **Migrate is not fatal** — a failed migration is surfaced by `/check` and
  the verbs; killing the container only hides the reason.
- **Supervise the server:** the shim restarts on crash with the reason logged,
  rather than taking the instance down silently.
- **The R2 boot transcript** (`crm/<ws>/boot.log`) is worth keeping
  permanently: it is the one channel that works when nothing can talk to a
  dying instance.

## 5. The open platform issue (production blocker)

See [cloudflare-incident.md](cloudflare-incident.md) for the support-case text.
Summary: every container running the real entrypoint stops within ~1–2 s of
its first steps; handler-side R2 puts vanish; public egress from containers is
dead — while a bare `sleep 900` survives and the **identical code ran in
production on 2026-09-29**.

### Elimination matrix

| Hypothesis | Test | Result |
|---|---|---|
| Entrypoint bug (bash logic) | full local runs, both archs, non-root, 4 GiB cap | ❌ eliminated — flawless locally |
| Image content / arch | arm64 + amd64 local runs; `ls`, migrate, shim inside both | ❌ eliminated |
| OOM at standard-1 (4 GiB) | `docker run --memory 4g` migrate | ❌ eliminated — `OOMKilled=false` |
| Registry layer corruption | clean rebuild → identical digest (reproducible build) | ❌ eliminated |
| Rollout lag (old one-shot image still serving) | deleted the container app, recreated fresh; waited full provisioning | ❌ eliminated |
| Interception (`outboundByHost` + `ContainerProxy`) | deployed with both removed | ❌ eliminated |
| Image ENTRYPOINT vs start-override | explicit `entrypoint` at class and per-start | ❌ eliminated |
| SDK activity kill (ours) | `onActivityExpired` override | ✅ real bug, fixed — necessary, not sufficient |
| SDK start race (ours) | `startAndWaitForPorts` budget | ✅ real bug, fixed — necessary, not sufficient |
| **Platform container data path** | clean-room Worker + app + image; entrypoint proven running (R2-side request logs) yet instance stops | ⏳ **unresolved — open, reproducible** |

The decisive evidence that containers *do* run: `wrangler tail` logged the
container's own `state.internal` requests (three `PUT …/boot.log`, one `GET
…/db.sqlite3`) reaching the Worker's outbound handler moments before each
death — so the entrypoint executes, then the instance stops before the shim
bind, with no output reaching any channel.

## 6. Impact and interim options

- **voki integration (Phase 2)** can proceed against the engine's contract —
  the tool layer targets the HTTP surface, which is final; the engine can run
  anywhere that surface lives.
- If the platform issue persists: (a) rclone/R2-S3-token state path (designed,
  not wired — removes the interception dependency but not the container
  deaths), (b) host the same image on a VM per `docs/docker.md` behind
  Cloudflare Tunnel, (c) wait out a possible platform incident — the cheapest
  first move, given the Sep-29 evidence.

## 7. Open items

Tracked as GitHub issues (linked from the PR that carries this document):

1. **Platform container data-path failure** — file the support case; re-run
   the E2E probe before any fallback work.
2. **Report the SDK eviction bug upstream** (`cloudflare/workers-sdk`) with
   the analysis in §2.
3. **Cleanup** — ~15 debug workspace prefixes in `openoutreach-crm`; the
   superseded `openoutreach` Worker (old app) to delete once the engine is
   confirmed.
4. **Fallback decision** — only after 1 resolves the platform picture.
