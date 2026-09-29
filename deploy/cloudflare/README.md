# deploy/cloudflare — the Cloudflare deploy

The full guide is **[docs/cloudflare.md](../../docs/cloudflare.md)** — this file is the
shortest path to a working deploy.

```bash
npm install
npx wrangler login                                    # once
npx wrangler r2 bucket create openoutreach-crm        # once
npx wrangler secret put OPENOUTFIND_PRODUCT_DOCS      # …and the rest of the variables
npx wrangler secret put RUN_TOKEN                     # guards the HTTP endpoints
npx wrangler deploy
```

| File | What it is |
|---|---|
| `wrangler.toml` | the Worker, the cron schedule, the goal, the container, the R2 binding |
| `src/index.ts` | the Worker: cron → one named container instance; four operator endpoints; the R2 outbound handler |
| `Dockerfile` | the job image — the released package from PyPI, non-root, state-sync entrypoint |
| `container-start` | restore from R2 → run one bounded job → checkpoint → upload |
