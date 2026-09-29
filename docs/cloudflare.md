# Cloudflare — Running OpenOutreach as a Scheduled Job

> **This is not the install path.** The supported install is `uvx openoutreach find 10` (or
> `pip install openoutreach`) — see the README quick start. This page is the Cloudflare
> counterpart of the [Docker guide](./docker.md): running the bounded job unattended on a
> schedule, without a server of your own.
>
> You need a Cloudflare account on the **Workers Paid plan** ($5/month — Containers require
> it), Docker for image builds, and Node.js for `wrangler`.

> **There is still no web surface.** What Cloudflare hosts is the same one-shot job the
> Docker image runs — `openoutreach find 10 emails` — on a Cron Trigger instead of a systemd
> timer. The few HTTP endpoints the deploy adds are for the *operator* (status, manual run,
> download the CSV); nothing about the product becomes a website.

---

## What the deploy is

Everything lives in [`deploy/cloudflare/`](../deploy/cloudflare/):

| Piece | What it is | Why |
|---|---|---|
| **Worker** (`src/index.ts`) | a Cron Trigger plus four small HTTP endpoints | the scheduler and the operator's remote control |
| **Container** (`Dockerfile`) | the released package from PyPI, on `python:3.12-slim` | the job itself — same image philosophy as the VM deploy |
| **Durable Object** | the `OutreachContainer` class, one *named* instance | the mutex: "one job per database, ever" by construction |
| **R2 bucket** (`openoutreach-crm`) | `db.sqlite3`, `home.tar.zst`, `leads.csv` | the CRM and the model caches between runs |

```text
Cron Trigger ──▶ Worker ──▶ Durable Object "openoutreach"  (the mutex)
                                  │ starts, with the secrets as env vars
                                  ▼
                     Container (standard-1) — one bounded job
                     container-start: restore state → run → checkpoint → upload
                                  │ plain HTTP to state.internal
                                  ▼
                     R2: db.sqlite3 · home.tar.zst · leads.csv
```

The mapping from the VM deploy, piece by piece:

| On the VM (docs/docker.md) | On Cloudflare |
|---|---|
| systemd timer / cron entry | Cron Trigger (`[triggers]` in `wrangler.toml`) |
| `--env-file` of `OPENOUTFIND_*` / `OUTSEND_*` | Worker secrets, passed in at `start()` |
| the mounted `./data` volume | the R2 bucket (see the state model below) |
| `ghcr.io/eracle/openoutreach` image | image built by `wrangler deploy`, in the Cloudflare Registry |
| "one job per database" by discipline | one *named* container instance — the Durable Object serializes starts |
| the journal / `docker logs` | Workers observability: dashboard, `wrangler tail` |

---

## The state model — the one real difference

**All container disk on Cloudflare is ephemeral.** When the instance sleeps or is replaced,
its disk is gone. So the CRM — one SQLite file — lives in R2, and the image's entrypoint
(`deploy/cloudflare/container-start`) wraps the job in a state sync:

1. **Restore**: download `db.sqlite3` from R2 (a 404 means a fresh install), and unpack
   `home.tar.zst` into `$HOME` (model caches, so cold starts don't re-download them).
2. **Run** the job — `openoutreach find <goal> <unit>` by default; `openoutreach run <goal>`
   when `OPENOUTREACH_SEND=1` (find → ingest → send). Its CSV is captured and uploaded as
   `leads.csv`; its narration goes to the container logs.
3. **Upload**: checkpoint the WAL into the main file, put `db.sqlite3` and `home.tar.zst`
   back in R2, exit with the job's own exit code.

Two properties worth stating plainly:

- **The sync rides the Worker's outbound proxy.** The script speaks plain HTTP to the
  virtual hostname `state.internal`; the Worker's `outboundByHost` handler resolves that
  against the R2 binding. The container never holds an R2 credential, and the CRM's bytes
  never leave Cloudflare's network.
- **A hard kill loses that run's writes.** The platform sends `SIGTERM` (the script
  checkpoints and uploads), waits up to 15 minutes, then `SIGKILL`s. A crash inside that
  window — or a mid-job host failure — loses whatever the job had written since the last
  successful upload. That is tolerable *by the product's own design*: a goal is "N more
  than you already have", so the next run picks up where the lost one began. The CSV is
  uploaded whatever the exit code; a rejected lead never exports, and a lead with no email
  still does — same rules as anywhere else.

Secrets do **not** live in R2. The wizard never runs in this deploy (there is no TTY), so
the `SiteConfig` row stays empty and the children read their `OPENOUTFIND_*` / `OUTSEND_*`
variables fresh from each `start()` — supplied from Worker secrets.

---

## One-time setup

```bash
cd deploy/cloudflare
npm install                       # wrangler, @cloudflare/containers, typescript
npx wrangler login                # once, if `npx wrangler whoami` says you are not
npx wrangler r2 bucket create openoutreach-crm
```

### The secrets

The job's environment is the same vocabulary the Docker deploy takes from `--env-file`
(`openoutreach/config/models.py` is the mapping). Set each with
`npx wrangler secret put <NAME>` — a variable that is set is never asked for, and the job
exits naming any it still lacks, so the fastest path is: set what you have, run the job
once, read the names it asks for.

| Variable | Needed for | What it is |
|---|---|---|
| `OPENOUTFIND_PRODUCT_DOCS` | finding | your product description (markdown) |
| `OPENOUTFIND_CAMPAIGN_TARGET` | finding | who you are going after, and the outcome |
| `OPENOUTFIND_AI_MODEL` | finding | `provider:model`, e.g. `anthropic:claude-sonnet-4-5-20250929` |
| `OPENOUTFIND_LLM_API_KEY` | finding | that provider's key |
| `OPENOUTFIND_LLM_API_BASE` | openai_compatible only | API base URL |
| `OPENOUTFIND_BETTERCONTACT_API_KEY` | finding | discovery (free) + email credits (paid) |
| `OPENOUTFIND_APOLLO_API_KEY` | optional email finder | never stands alone |
| `OPENOUTFIND_OPERATOR_EMAIL` | finding | keys the contacts store |
| `OPENOUTFIND_OPERATOR_COUNTRY` | finding | your ISO-3166 jurisdiction (e.g. `US`) |
| `OUTSEND_MAILBOX_ADDRESS` | sending | the box the mail leaves from |
| `OUTSEND_MAILBOX_PASSWORD` | sending | its **app password** |
| `OUTSEND_OPERATOR_NAME` | sending | the name that signs the mail |
| `OUTSEND_SMTP_HOST` / `_PORT`, `OUTSEND_IMAP_HOST` / `_PORT` | non-Google mailbox | blank for Google Workspace |
| `OUTSEND_BOOKING_LINK`, `OUTSEND_SIGNATURE`, `OUTSEND_AI_MODEL`, `OUTSEND_LLM_API_KEY`, … | sending | the sender's own copies of the shared answers |

Then one secret of ours:

```bash
npx wrangler secret put RUN_TOKEN   # e.g. output of: openssl rand -hex 32
```

`RUN_TOKEN` guards the HTTP endpoints (everything except `GET /`).

### The schedule and the goal

In `wrangler.toml`:

```toml
[triggers]
crons = ["0 9 * * 1-5"]       # UTC — align with the mailbox's sending window

[vars]
OPENOUTREACH_GOAL = "10"      # ten more leads carrying a verified address
OPENOUTREACH_UNIT = "emails"  # (at most 10 credits)
OPENOUTREACH_SEND = "0"       # "1" = also mail what was found (the `run` flow)
```

Sending is **off by default**, for the same reason the CLI keeps spending opt-in: a
forgotten switch must not be able to send your mail. Turn it on when the pipeline has
earned it.

### Deploy

```bash
npx wrangler deploy
```

Wrangler builds the image with Docker (the first build takes a few minutes — sklearn,
onnxruntime and friends), pushes it to the Cloudflare Registry, and deploys the Worker.
Your endpoints are at `https://openoutreach.<YOUR_SUBDOMAIN>.workers.dev`.

> Containers are not instant after the *first* deploy — the platform provisions instances
> for a few minutes. The Worker URL answers right away; the first `POST /run` may error
> until provisioning finishes.

---

## Operating it

`BASE` is your Worker URL; `TOKEN` is `RUN_TOKEN`.

```bash
curl $BASE/                                    # what this is (open)
curl -H "Authorization: Bearer $TOKEN" $BASE/status
curl -X POST -H "Authorization: Bearer $TOKEN" "$BASE/run?goal=5&unit=emails"
curl -H "Authorization: Bearer $TOKEN" $BASE/leads -o leads.csv
curl -H "Authorization: Bearer $TOKEN" $BASE/db -o db.sqlite3
```

- **`GET /status`** — the container state and the last run's exit code and time.
- **`POST /run`** — start a job now (goal/unit optional; defaults from `wrangler.toml`).
  Returns `409` if one is already running — the same "one job per database, ever" rule.
- **`GET /leads`** — the CSV of the last run, in the importer-ready shape (`email`,
  `first_name`, `last_name`, `company`, `title`, `website`, `linkedin_url`, `reason`, …).
- **`GET /db`** — the SQLite file itself, for any SQLite client.

**Logs** — the job's narration (stderr) is in the dashboard under
*Workers & Pages → Containers*, or live:

```bash
npx wrangler tail
```

**Cron with no configuration yet** does no harm: the job starts, `find` exits naming the
variables it lacked, the logs say which — and the state sync still uploads the fresh
database, so the very first entry in R2 is created by the first run.

### Changing things

- **Schedule or goal**: edit `wrangler.toml`, `npx wrangler deploy` again.
- **The package version**: bump `OPENOUTREACH_VERSION` in `deploy/cloudflare/Dockerfile`
  (default: the latest release on PyPI), then redeploy. `wrangler deploy` pushes only the
  changed image layers; running instances pick the new image up with a rollout.
- **Tear it all down**:
  ```bash
  npx wrangler delete               # the Worker (container image with it)
  npx wrangler r2 bucket delete openoutreach-crm   # the CRM — your leads; copy first
  ```

---

## Cost

The job runs on a `standard-1` instance (½ vCPU, 4 GiB memory, 8 GB disk — the memory is
for the embedding model, the disk for the venv). Billing is per 10ms of *running* time; a
job that isn't running costs nothing.

| Job length | Memory (4 GiB provisioned) | vCPU (½, active) | Disk (8 GB) |
|---|---|---|---|
| 30 min/day | 60 GiB-h/mo → ~$0.32 over the 25 included | ~450 min/mo → ~$0.09 over the 375 included | 120 GB-h/mo, included |
| 2 h/day | 240 GiB-h/mo → ~$1.94 | ~1800 min/mo → ~$1.71 | ~$0.07 |

So: **the $5/month Workers Paid plan, plus well under a dollar for one short job a day.**
R2 storage for the CRM and caches is pennies (a few GB at $0.015/GB/month); R2 egress is
free.

---

## Notes and limits

- **The image installs from PyPI, not from your checkout** — the build context is
  `deploy/cloudflare/` and holds no Python sources, and the released package *is* the
  supported install. To run unreleased code, build and push it explicitly:
  ```bash
  docker build -t openoutreach:dev -f compose/openoutreach/Dockerfile .   # from the repo root
  npx wrangler containers push openoutreach:dev
  ```
  …then point `image` in `wrangler.toml` at the printed `registry.cloudflare.com/…`
  reference. The compose image needs its gosu entrypoint dropped for Cloudflare's
  non-root runtime — this is why the deploy ships its own Dockerfile.
- **Placement is global.** Container instances start wherever Cloudflare has capacity
  pre-warmed; you cannot pin a region. If your jurisdiction cares where lead data is
  processed, weigh that before putting the CRM in R2.
- **`enableInternet` stays on, on purpose.** The sender's SMTP/IMAP egress uses ports the
  outbound proxy cannot carry; only HTTP/HTTPS is interceptable. If you want an allowlist
  anyway, `deniedHosts` on the `OutreachContainer` class is the hook.
- **Cold starts re-unpack the caches** (`home.tar.zst`) rather than re-downloading them —
  the first run is the slow one.
- **Backups are your job.** `GET /db` gives you the file; the bucket has no versioning
  unless you turn it on (`wrangler r2 bucket versioning enable openoutreach-crm`).

---

## Troubleshooting

| Symptom | What it means |
|---|---|
| job exits naming `OPENOUTFIND_*` / `OUTSEND_*` variables | exactly what it says: `npx wrangler secret put` each name, then `POST /run` again |
| `state store unreachable` in the logs | the container could not reach `state.internal` — the outbound handler did not run; check that `src/index.ts` still exports `ContainerProxy` |
| `401` from the endpoints | wrong `RUN_TOKEN` (or none set — everything but `GET /` requires it) |
| deploy fails asking for a paid plan | Containers need Workers Paid ($5/month) |
| a run's leads vanished | a hard stop between checkpoint and upload — see the state model; the next run continues from the last good upload |
| `POST /run` returns `409` | a job is already running — check `GET /status` |
