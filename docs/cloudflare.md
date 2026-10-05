# Cloudflare — the multi-tenant outreach engine

> **This is not the install path.** The supported install is `uvx openoutreach find 10` (or
> `pip install openoutreach`) — see the README quick start. This page documents what runs on
> Cloudflare: a **sending and CRM engine** that a calling agent drives over HTTP. It replaced
> an earlier single-tenant scheduled-find deploy on 2026-10-04.
>
> **Production status (2026-10-05):** the engine is complete and verified locally on arm64
> and amd64, but production containers are currently blocked by a Cloudflare platform
> issue — see [cloudflare-findings.md](cloudflare-findings.md) (postmortem) and
> [cloudflare-incident.md](cloudflare-incident.md) (support case). The HTTP contract below
> is final and safe to build against.
>
> You need a Cloudflare account on the **Workers Paid plan** ($5/month — Containers require
> it), Docker for image builds, and Node.js for `wrangler`.

## What the engine is — and is not

The engine **sends email and remembers**. It deliberately does **not find leads**: the calling
agent discovers and qualifies people itself, and hands them over through the public ingest
contract. The split, and why:

| Concern | Owner |
|---|---|
| Finding and qualifying leads | the calling agent (voki: its own model + its own data tools) |
| Writing the openers | the calling agent, via the `draft_pending` protocol |
| Leads in (JSON Lines, upsert on `lead_id`) | **the engine** — suppression checked at the door |
| Mailbox, SMTP/IMAP, sending window, daily cap, pacing | **the engine** |
| The CRM: leads, deals, conversations, mail log, suppression | **the engine** — one SQLite file per workspace |

Because openers arrive as answers to `draft_pending` (the CLI's `--agent-draft` contract),
**the engine never needs an LLM key** — no `OUTSEND_AI_MODEL`, no second model bill.

The consumers of this design are **workspaces** — today, voki Slack workspaces. Each gets its
own database; nothing is shared but the image.

## Architecture

```text
voki trusted app (or curl with the service token)
   │  Authorization: Bearer <OUTREACH_SERVICE_TOKEN>
   ▼
openoutreach Worker ── PUT/GET /w/<ws>/config ──► Durable Object storage
   │                                            (the workspace's OUTSEND_* env)
   ├─ GET /w/<ws>/db ─────────────────────────► R2  crm/<ws>/db.sqlite3 (served directly)
   ▼
Durable Object "workspace id" = the mutex (one run per database, ever)
   │ starts the container with the stored env + WORKSPACE_ID
   ▼
engine container (standard-1) — container-start restores state from R2,
runs shim.py on :8080 for the life of the instance
   │ POST /ingest /send /draft /check · GET /pending /crm/*
   │ http://state.internal/... (the Worker's outbound handler → R2)
   ▼
R2 bucket: crm/<ws>/{db.sqlite3, home.tar.gz, job.json}
   │
   SMTP/IMAP ► the workspace's mailbox   (egress is plain internet, on purpose)
```

The rules the first deploy established still hold:

- **One job per database, ever.** The DO per workspace serializes starts; the shim's run
  mutex serializes CLI invocations inside the container.
- **Credentials never enter the container image or R2.** Per-workspace config lives in DO
  storage and is applied as the container environment at `start()`; the R2 sync rides the
  Worker's outbound proxy on `state.internal`.
- **Disk is ephemeral.** The entrypoint restores the workspace's SQLite file and home dir
  from R2; the shim uploads them back after every change, and on SIGTERM. A hard kill
  between the last sync and the next start loses that window's writes — and the verbs are
  resumable, so the caller re-issues them.

## The HTTP surface

`BASE = https://openoutreach.<subdomain>.workers.dev`, auth on everything but `GET /`:
`Authorization: Bearer $OUTREACH_SERVICE_TOKEN`. `<ws>` is a slug (`^[a-z0-9][a-z0-9_-]{0,63}$`)
— voki uses the Slack workspace id lowercased.

| Endpoint | What it does |
|---|---|
| `PUT /w/<ws>/config` | body `{env: {...}}` — `OUTSEND_*` keys only, values ≤ 20 KB. Stored in the workspace's DO; **stops a running container** so the next start applies it |
| `GET /w/<ws>/config` | which keys are set (values are never returned) |
| `POST /w/<ws>/ingest` | body = **JSON Lines**, one record per line — the public pipe. Upserts on `lead_id`, latest-wins; suppression checked and terminal; a malformed line is skipped and counted; a blank `email` is stored, not rejected |
| `POST /w/<ws>/send` | `{n?: 5 \| "all"}` — starts a sending pass in `--agent-draft` mode (async; poll `/pending`). The pass reads the mail, answers replies, and stops at the first deal needing an opener |
| `POST /w/<ws>/draft` | `{subject, body}` — answers `draft_pending`; the engine sends it as soon as a mailbox is free (an answer given while guards hold is kept, not thrown away) |
| `GET /w/<ws>/pending` | the job document: `phase` (`idle`/`running`/`draft_pending`/`done`/`error`), the pending deal's fields when a draft waits, `last_ingest`, `last_check` |
| `POST /w/<ws>/check` | `outsend check`: what a run needs — including a **real SMTP login** for the mailbox. Use it to verify a config before relying on it |
| `GET /w/<ws>/crm/leads?limit=` | leads joined with deal state (`Ready`/`Emailed`/`Completed`), outcome, reason, sent-at, chat summary, suppression flag |
| `GET /w/<ws>/crm/conversations?limit=` | the mail log newest-first, joined to the lead and deal |
| `GET /w/<ws>/crm/mailbox` | connected mailboxes: hosts, daily limit, `next_send_at` (the learned pacing). No credentials in the response |
| `GET /w/<ws>/db` | the SQLite file itself, streamed from R2 |

The ingest record is the finder's documented JSON shape — send at least `lead_id` (required,
stable key), `email`, `first_name`, `last_name`, `company`, `title`, `website`,
`linkedin_url`, and `profile_text` (what an opener is written from). The engine ignores keys
it does not know.

### The draft loop, end to end

```text
POST /w/<ws>/send                → 202 {started}
GET  /w/<ws>/pending             → phase: draft_pending
                                    {profile_text, company, title, ...}
   (the calling agent writes the opener)
POST /w/<ws>/draft {subject, body} → 202 {started}
GET  /w/<ws>/pending             → phase: done (or the next draft_pending)
```

A `draft_pending` survives container sleep (it is persisted with the job document and in the
engine's own tables); a bare `POST /send` re-raises it if the answer was never given.

## One-time setup

```bash
cd deploy/cloudflare
npm install
npx wrangler login                      # once
npx wrangler r2 bucket create openoutreach-crm
npx wrangler secret put OUTREACH_SERVICE_TOKEN   # e.g. openssl rand -hex 32
npx wrangler deploy
```

The image installs the released package from PyPI (`OPENOUTREACH_VERSION` in the Dockerfile);
`wrangler deploy` builds and pushes it (the first build takes a few minutes) and updates
running instances with a rollout.

### Per-workspace configuration

The sender's own vocabulary, nothing else (`openoutreach/config/models.py` is the mapping):

| Variable | Required | What it is |
|---|---|---|
| `OUTSEND_PRODUCT_DOCS` / `OUTSEND_CAMPAIGN_TARGET` | ✅ | what a message is written from |
| `OUTSEND_OPERATOR_NAME` / `OUTSEND_OPERATOR_EMAIL` / `OUTSEND_OPERATOR_COUNTRY` | ✅ | who signs; the email is BCC'd on every send |
| `OUTSEND_MAILBOX_ADDRESS` / `OUTSEND_MAILBOX_PASSWORD` | ✅ | the box to send from, and its **app password** |
| `OUTSEND_SMTP_HOST/_PORT`, `OUTSEND_IMAP_HOST/_PORT` | non-Google | blank = Gmail defaults |
| `OUTSEND_BOOKING_LINK`, `OUTSEND_SIGNATURE` | optional | call link; sign-off |

No `OUTSEND_AI_MODEL` — openers arrive through `/draft`.

```bash
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"env": {"OUTSEND_PRODUCT_DOCS": "...", "OUTSEND_MAILBOX_ADDRESS": "you@co.com", ...}}' \
  $BASE/w/<ws>/config
curl -X POST -H "Authorization: Bearer $TOKEN" $BASE/w/<ws>/check   # verifies incl. SMTP login
```

## Operating it

```bash
TOKEN=...; BASE=https://openoutreach.appifex-ai.workers.dev; WS=<workspace>

# leads in (from anywhere producing the JSON contract)
curl -X POST -H "Authorization: Bearer $TOKEN" --data-binary @leads.jsonl $BASE/w/$WS/ingest

# one sending pass, openers by the agent
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{}' $BASE/w/$WS/send
curl -H "Authorization: Bearer $TOKEN" $BASE/w/$WS/pending          # → draft_pending + fields
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"subject":"...","body":"..."}' $BASE/w/$WS/draft

# the CRM
curl -H "Authorization: Bearer $TOKEN" "$BASE/w/$WS/crm/leads?limit=20"
curl -H "Authorization: Bearer $TOKEN" "$BASE/w/$WS/crm/conversations?limit=20"
```

- **Logs**: dashboard (*Workers & Pages → Containers*) or `npx wrangler tail`. The shim
  prefixes every line with `[engine:<ws>]`.
- **Scheduling** is the caller's decision (voki's CronJob scheduler fires sending passes);
  the engine has no cron of its own.
- **Cost**: `standard-1` billed only while an instance is up — an instance exists while a
  workspace is actively running something, sleeps 15 minutes after idle, and restores in
  seconds when woken. Realistically: the $5 plan plus cents per workspace per day.
- **Updating**: bump `OPENOUTREACH_VERSION`, `npx wrangler deploy` (layer-cached).
- **Teardown**: `npx wrangler delete`, then `npx wrangler r2 bucket delete openoutreach-crm`
  (per-workspace data included — copy `/w/<ws>/db` first if it matters).

## Notes and limits

- **Sending is externally visible.** The engine sends when told via `/send`/`/draft`; it has
  no judgment of its own about consent. The calling agent must apply the ask-first rule (in
  voki, that lives in the tool layer).
- **The mailbox reputation is the customer's.** The engine's guards prevent mechanical
  over-sending (one shared window, cap and pacing for openers *and* follow-ups); they cannot
  prevent bad copy. Every message carries a `Sent with OpenOutreach` footer — always on.
- **A lead who never answers gets two more emails**, then the deal closes as `unresponsive`.
- **Suppression is terminal** — an opted-out address never re-enters through ingest.
- **Placement is global**; the CRM's R2 bucket sits in one region. Jurisdiction-sensitive
  workspaces are a deployment question to answer before onboarding.
- **The app password lives in two places**: the workspace's DO storage (engine config) and
  the engine's own mailbox row (it is how the provider login works). Both are ours to
  operate; neither is in the image or the repo.

## Troubleshooting

| Symptom | What it means |
|---|---|
| `/pending` shows an error naming `OUTSEND_*` variables | the workspace config is incomplete — `PUT /config` the names it lists |
| `409 {"error":"busy"}` | a run already holds this workspace's database — poll `/pending` |
| `409 {"error":"no_pending_draft"}` | `/draft` without a pending draft — `/send` first |
| `state store unreachable` in logs | the container could not reach `state.internal` — check that `src/index.ts` still exports `ContainerProxy` |
| `401` | wrong service token |
| `workspace_not_configured` | `PUT /w/<ws>/config` before anything else |
