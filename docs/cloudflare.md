# Cloudflare — the multi-tenant outreach engine

> **This is not the install path.** The supported install is `uvx openoutreach find 10` (or
> `pip install openoutreach`) — see the README quick start. This page documents what runs on
> Cloudflare: a **sending and CRM engine** that a calling agent drives over HTTP. It replaced
> an earlier single-tenant scheduled-find deploy on 2026-10-04.
>
> **Production status (2026-10-05):** verified end to end in production. The 2026-10-04
> outage and its root cause — an outbound handler that was never registered — are in
> [cloudflare-findings.md](cloudflare-findings.md).
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
**the engine never needs an LLM key** — no model setting, no second model bill.

The consumers of this design are **workspaces** — today, voki Slack workspaces. Each gets its
own database; nothing is shared but the image.

## Architecture

```text
voki trusted app (or curl with the service token)
   │  Authorization: Bearer <OUTREACH_SERVICE_TOKEN>
   ▼
openoutreach Worker ── PUT/GET /w/<ws>[/sender|/campaign|/mailboxes/…]
   │                     └─► Durable Object storage: sender, campaign, mailbox pool
   │                         (the one place credentials live; never in a response)
   ├─ GET /w/<ws>/db ─────────────────────────► R2  crm/<ws>/db.sqlite3 (served directly)
   ▼
Durable Object "workspace id" = the mutex (one run per database, ever)
   │ starts the container with the settings rendered as OUTSEND_* + ENGINE_MAILBOXES
   ▼
engine container (standard-1) — container-start restores state from R2,
reconciles the sender and mailbox pool into the database, then
runs shim.py on :8080 for the life of the instance
   │ POST /leads /send /draft /check · GET /pending /mailboxes /crm/*
   │ http://state.internal/... (the Worker's outbound handler → R2)
   ▼
R2 bucket: crm/<ws>/{db.sqlite3, home.tar.gz, job.json}
   │
   SMTP/IMAP ► the workspace's mailbox   (egress is plain internet, on purpose)
```

The rules the first deploy established still hold:

- **One job per database, ever.** The DO per workspace serializes starts; the shim's run
  mutex serializes CLI invocations inside the container.
- **Credentials live in the workspace's Durable Object and nowhere else.** They reach the
  container as its environment at `start()`; the shim uploads the database to R2 with mailbox
  passwords blanked, so neither R2 nor `GET /db` ever holds one. The R2 sync rides the
  Worker's outbound proxy on `state.internal`, and a container may only touch its own
  workspace's `crm/<ws>/` prefix.
- **Disk is ephemeral.** The entrypoint restores the workspace's SQLite file and home dir
  from R2; the shim uploads them back after every change, and on SIGTERM. A hard kill
  between the last sync and the next start loses that window's writes — and the verbs are
  resumable, so the caller re-issues them.

## The HTTP surface

`BASE = https://openoutreach-engine.<subdomain>.workers.dev`, auth on everything but `GET /`:
`Authorization: Bearer $OUTREACH_SERVICE_TOKEN`. `<ws>` is the tenant key
(`^[a-z0-9][a-z0-9_-]{0,63}$`) — voki uses its own workspace id, one per Slack team. The API
speaks in the workspace's terms: a **sender**, a **campaign** and a **pool of mailboxes**. The
sender's `OUTSEND_*` variables are an internal detail of the Worker; no request or response
names one.

### Settings

| Endpoint | What it does |
|---|---|
| `GET /w/<ws>` | `{ready, missing: ["sender"\|"campaign"\|"mailboxes"], sender, campaign, mailboxes}` — answered from the Durable Object, no container start; never returns a credential |
| `PUT /w/<ws>` | onboarding in one call: any of `{sender, campaign, mailboxes: [...]}`. Sections given replace those sections; mailboxes are upserted by address; anything not given is kept |
| `PUT /w/<ws>/sender` | `{name, email?, country?}` — who signs; `email` is BCC'd on every send |
| `PUT /w/<ws>/campaign` | `{product, target, booking_link?}` — markdown, ≤ 20 000 chars each; what openers are written from |
| `PUT /w/<ws>/mailboxes/<address>` | `{app_password, smtp?: {host, port}, imap?: {host, port}, signature?}` — Gmail when `smtp`/`imap` are omitted. **The SMTP login is checked before it is kept**: `422 mailbox_rejected` with the provider's reason, and the previous credentials (or no box) stand |
| `DELETE /w/<ws>/mailboxes/<address>` | **retire** the box: it opens no new conversations and sends no follow-ups, but replies on its threads are still read and answered. A delete would cascade its mail history, so there is none |
| `GET /w/<ws>/mailboxes` | each box: connected or the reason it is not, retired, learned `daily_limit`, `next_send_at` |
| `DELETE /w/<ws>` | forget the workspace: settings, container (killed, so nothing syncs back) and every object under `crm/<ws>/` — **irreversible** |

Changing any setting restarts the workspace's container (settings are applied at start), which
aborts a run in progress; every verb is resumable. Up to 25 mailboxes per workspace — the
sender spreads first emails across the free boxes, each on its own pacing clock and learned
daily capacity, and a thread always continues from the box that opened it.

### Work

| Endpoint | What it does |
|---|---|
| `POST /w/<ws>/leads` | body = **JSON Lines**, one record per line — the public pipe. Upserts on `lead_id`, latest-wins; suppression checked and terminal; a malformed line is skipped and counted; a blank `email` is stored, not rejected |
| `POST /w/<ws>/send` | `{n?: 5 \| "all"}` — starts a sending pass in `--agent-draft` mode (async; poll `/pending`). The pass reads the mail, answers replies, and stops at the first deal needing an opener |
| `POST /w/<ws>/draft` | `{subject, body}` — answers `draft_pending`; the engine sends it as soon as a mailbox is free (an answer given while guards hold is kept, not thrown away) |
| `GET /w/<ws>/pending` | the job document: `phase` (`idle`/`running`/`draft_pending`/`done`/`error`), the pending deal's fields when a draft waits, `last_ingest`, `last_check` |
| `POST /w/<ws>/check` | what an `--agent-draft` pass needs (no model is asked for), reported in the API's field names (`set mailboxes`) |
| `GET /w/<ws>/crm/leads?limit=` | leads joined with deal state (`Ready`/`Emailed`/`Completed`), outcome, reason, sent-at, chat summary, suppression flag |
| `GET /w/<ws>/crm/conversations?limit=` | the mail log newest-first, joined to the lead and deal |
| `GET /w/<ws>/db` | the SQLite file itself, streamed from R2 — mailbox passwords blanked |

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

### Onboarding a workspace

```bash
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{
  "sender":   {"name": "Jo Smith", "email": "jo@acme.com", "country": "US"},
  "campaign": {"product": "# Acme ...", "target": "Heads of operations at ..."},
  "mailboxes": [{"address": "jo@acme.com", "app_password": "abcd efgh ijkl mnop"}]
}' $BASE/w/<ws>
# → 200 {"ready": true, ...}   or 422 {"error": "mailbox_rejected", "rejected": [{address, reason}]}
```

A mailbox is connected with its provider **app password** (Google: Account → Security →
2-Step Verification → App passwords). Sign-in-with-Google would need the sender to send through
the Gmail API instead of SMTP/IMAP; that is an OpenOutSend change, and the mailbox resource
would carry a token in place of `app_password`.

## Operating it

```bash
TOKEN=...; BASE=https://openoutreach-engine.appifex-ai.workers.dev; WS=<workspace>

# leads in (from anywhere producing the JSON contract)
curl -X POST -H "Authorization: Bearer $TOKEN" --data-binary @leads.jsonl $BASE/w/$WS/leads

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
- **The app password lives in the workspace's Durable Object** and, while an instance runs,
  in that container's database (the sender logs in from its mailbox row). The copy synced to
  R2 has it blanked; the next start restores it from the Durable Object.

## Troubleshooting

| Symptom | What it means |
|---|---|
| `/check` says `set sender`/`campaign`/`mailboxes` | `GET /w/<ws>` lists what is missing; `PUT` it |
| `409 {"error":"busy"}` | a run already holds this workspace's database — poll `/pending` |
| `409 {"error":"no_pending_draft"}` | `/draft` without a pending draft — `/send` first |
| `state store unreachable` in logs | the container could not reach `state.internal` — check that `src/index.ts` still exports `ContainerProxy` |
| `401` | wrong service token |
| `workspace_not_configured` | `PUT /w/<ws>` before anything else |
| `422 mailbox_rejected` | the provider refused the login — the reason is the provider's; usually a regular password where an app password is needed, or a non-Google box without `smtp`/`imap` |
