# deploy/cloudflare — the multi-tenant outreach engine

The full guide is **[docs/cloudflare.md](../../docs/cloudflare.md)** — this file is the
shortest path to a working deploy. The engine sends email and holds the CRM; the calling
agent (voki) finds/qualifies leads, ingests them as JSON Lines, and writes openers through
the `draft_pending` protocol.

> **Status (2026-10-05):** verified end to end in production. Register outbound handlers by
> assignment, never as a `static` class field — see
> [docs/cloudflare-findings.md](../../docs/cloudflare-findings.md).

```bash
npm install
npx wrangler login                                        # once
npx wrangler r2 bucket create openoutreach-crm            # once
npx wrangler secret put OUTREACH_SERVICE_TOKEN            # the bearer token for callers
npx wrangler deploy
```

Then per workspace: `PUT /w/<ws>/config` (the `OUTSEND_*` env), `POST /w/<ws>/check` to
verify the mailbox by a real SMTP login, `POST /w/<ws>/ingest` leads, `POST /w/<ws>/send`.

| File | What it is |
|---|---|
| `wrangler.toml` | the Worker, the container, the DO binding, the R2 binding |
| `src/index.ts` | the Worker: per-workspace routing, config in DO storage, the R2 outbound handler |
| `Dockerfile` | the engine image — the released package from PyPI, non-root, port 8080 |
| `container-start` | restore state from R2 → migrate → run the shim (server mode) |
| `shim.py` | the engine itself: ingest/send/draft/check + CRM reads + the R2 state sync |
