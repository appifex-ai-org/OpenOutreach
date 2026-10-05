# Cloudflare multi-tenant engine — engineering findings (2026-10-04/05)

This is the postmortem of the multi-tenant engine build session: what was
built and verified, the bug that took production down and its root cause,
the smaller fixes and hardening lessons, and the investigation that blamed
the platform first — kept because how it went wrong is the useful part.
The engine's contract is [cloudflare.md](cloudflare.md).

**Status: resolved.** The production engine passes end to end on
2026-10-05: cold start → restore → migrate → shim on :8080 in ~9 s,
`/check`, ingest (malformed-line contract exact), CRM reads, R2 sync of
`db.sqlite3` and `boot.log`, and **restart restore** (a lead ingested before
a forced restart is read back after it).

## 1. What was built

Scope (per the voki integration decision): **send + CRM only**. The engine
ingests leads through the public JSON-Lines contract, sends mail with the
caller's openers (`--agent-draft`), and serves the sender's tables as CRM
reads. No discovery, no BetterContact key, no LLM key.

| Component | File | Role |
|---|---|---|
| Engine shim | `deploy/cloudflare/shim.py` | `/ingest` `/send` `/draft` `/check` `/pending` + `/crm/*` reads; the `draft_pending` protocol as request/response; R2 state sync after every change |
| Entrypoint | `deploy/cloudflare/container-start` | restore from R2 → migrate (non-fatal) → supervised shim; per-step boot transcript to R2 |
| Worker | `deploy/cloudflare/src/index.ts` | per-workspace named DO instances (the mutex), config in DO storage applied as container env, service-token auth, R2-served `/db`, the `state.internal` → R2 handler |
| Image | `deploy/cloudflare/Dockerfile` | openoutreach 0.1.60 from PyPI, non-root, port 8080 |

Verified locally before production: linux/arm64 and linux/amd64 builds,
non-root execution, a 4 GiB memory cap on migrate, the ingest contract, the
draft protocol, R2 sync and restart restore against a mock state store.

## 2. Root cause — the state handler was never registered

**Symptom:** every container running the real entrypoint stopped within
~1–2 s (`Container crashed while checking for ports`); the R2 objects the
container uploaded never appeared; a bare `sleep 900` ran fine.

**Cause:** the handler was declared the way the `@cloudflare/containers`
README shows it:

```ts
export class OutreachContainer extends Container {
  static outboundByHost = { "state.internal": handler };   // ← never registered
}
```

The SDK stores handlers through a **static setter** on `Container`
(`set outboundByHost(h) { registry.set(this.name, h) }`), and
`ContainerProxy` — the entrypoint that actually serves intercepted requests —
reads that registry. A native class field (TS `target: es2022`, so
`useDefineForClassFields` is on and esbuild emits the field as written) is
**defined** on the subclass, shadowing the setter; the setter never runs and
the registry stays empty. The constructor still sees the own property, so
`state.internal` *is* intercepted — and `ContainerProxy`, finding no handler,
falls through to `enableInternet` and forwards the request to the public
internet, where `state.internal` does not resolve.

So every request from the container was answered with an error: uploads went
nowhere, and the entrypoint's `restore db.sqlite3` got neither 200 nor 404,
took its `FATAL: state store unreachable` branch and exited. That is exactly
the 3 × `PUT boot.log` + 1 × `GET db.sqlite3` that `wrangler tail` showed
before every death: transcript, restore, FATAL step, EXIT-trap flush. The
`sleep 900` instance survived because it never touched the state store.

**Fix:** register by assignment after the class, which goes through the
setter (`OutreachContainer.outboundByHost = { [STATE_HOST]: stateStore }`
in `src/index.ts`). The handler also buffers PUT bodies before `R2.put` and
logs every state request and failure — a failure there is otherwise silent,
because nothing in the container can be heard.

**Upstream:** the README's own example has this defect under native class
fields; worth reporting to `cloudflare/workers-sdk` (or fixing the SDK to
read the static property directly instead of a setter-fed registry).

**Why it was hard to see:** the tail showed the intercepted requests as
`Ok` — that is the proxy invocation succeeding, not the handler — and the
handler had no logging, so "the handler ran" was inferred, never observed.
Adding one `console.log` to it was the decisive experiment.

## 3. The investigation that blamed the platform (and what to keep)

Before the root cause, nine hypotheses were tested. Several real fixes came
out of it; the conclusion — "a platform regression between 2026-09-29 and
2026-10-04" — was wrong.

| Hypothesis | Result |
|---|---|
| Entrypoint bash logic, image content/arch, OOM, registry corruption, rollout lag, ENTRYPOINT vs start override | eliminated — all fine |
| Interception itself (`outboundByHost` + `ContainerProxy` removed) | containers still died — expected in hindsight: with no state store at all, restore still takes the FATAL branch |
| "Public egress from containers is dead" | invalid test — the heartbeat curled the *old* Worker's URL, and the `/net-report` route sat behind service-token auth |
| SDK activity kill on DO eviction | see §4 — the override is kept, but the eviction story does not hold for 0.3.7 |
| `start()` scheduling race | real, fixed — see §4 |
| **Platform container data path** | **not a platform issue** — the unregistered handler (§2) |

Not explained: the claim that the identical code ran on 2026-09-29 with
working state sync. The class-field declaration is the same in that commit;
whatever made it work then (a different build, or a different path to R2)
was not reconstructed.

Lesson: when a proxy hop is involved, log at the handler before reasoning
about the platform behind it.

## 4. Smaller fixes (kept)

- **`start()` race:** `Container.start()` issues a fire-and-forget start,
  then health-fetches the port; if the instance is still scheduling, the
  error path awaits `this.monitor`, which only settles when the container
  stops. `ensureStarted()` uses `startAndWaitForPorts` with a 90 s budget —
  cold boots legitimately take seconds (restore + migrate on ½ vCPU).
- **`onActivityExpired` override:** derives liveness from the persisted
  `getState().lastChange` and re-arms rather than stopping. It was written
  for an eviction theory — `sleepAfterMs` resetting to 0 in a fresh DO —
  but in 0.3.7 the constructor calls `renewActivityTimeout()`, so a fresh
  instance gets a full window. The override is harmless and explicit, so it
  stays; it is not evidence of an SDK bug.

## 5. Hardening lessons (in `container-start`)

- **No process substitution** (`exec > >(tee …)`) — plain file redirection.
- **Never let diagnostics kill boot:** the transcript is a file uploaded
  with a bounded `curl --max-time 5`; `log()` writes can't fail the script.
- **Migrate is not fatal** — `/check` and the verbs surface a failed one.
- **Supervise the server:** the shim restarts on crash with the reason
  logged.
- **The R2 boot transcript** (`crm/<ws>/boot.log`) stays: once the handler
  was registered it showed the whole boot on the first try.

## 6. Open items

1. **Report the class-field registration defect upstream** (§2).
2. **Cleanup** — debug workspace prefixes in `openoutreach-crm` (`crm/dbg*`,
   `crm/e2e-*`, `crm/probe-*`, …) and the superseded `openoutreach` Worker,
   now that the engine is confirmed.
