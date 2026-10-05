// src/index.ts — the multi-tenant outreach engine Worker (docs/cloudflare.md).
//
// One Worker fronts any number of workspaces. Each workspace gets its own
// named container instance (its own Durable Object, its own database, its
// own R2 prefix crm/<workspace>/), and the calling agent — voki's trusted
// application — drives it over a small HTTP surface with a service token.
//
// Scope, deliberately: this engine SENDS and remembers. It does not find.
// The caller discovers and qualifies leads itself and hands them over
// through the documented ingest contract (JSON Lines, upserted on lead_id,
// suppression checked at the door). Openers are written by the caller too,
// through the draft_pending protocol — the engine never needs an LLM key.
//
// The two rules the old single-tenant deploy lived by still hold:
//  - one job per database, ever — the Durable Object per workspace is the
//    mutex, and the shim serializes CLI runs inside the container;
//  - the R2 credentials never enter the container — state traffic rides
//    the outbound proxy on the virtual hostname state.internal.

import { Container, ContainerProxy, getContainer } from "@cloudflare/containers";

// Required for outbound interception to work.
export { ContainerProxy };

/** Virtual hostname the shim's state sync talks to; routed to R2. */
const STATE_HOST = "state.internal";

/** Workspace ids: slack-style slugs, safe as R2 key segments and DO names. */
const WS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Per-workspace configuration is the sender's own vocabulary, nothing else. */
const ENV_PATTERN = /^OUTSEND_[A-Z0-9_]+$/;

const MAX_ENV_KEYS = 40;
const MAX_ENV_VALUE = 20_000; // product docs are pages of markdown

interface StoredConfig {
  ws: string;
  env: Record<string, string>;
}

export interface Env {
  OUTREACH: DurableObjectNamespace<OutreachContainer>;
  CRM: R2Bucket;
  OUTREACH_SERVICE_TOKEN?: string;
}

export class OutreachContainer extends Container {
  /** The shim's HTTP surface; readiness is the port accepting connections. */
  defaultPort = 8080;
  requiredPorts = [8080];
  /**
   * Explicit on purpose: this app's instances did not honor the image's
   * baked-in ENTRYPOINT (they exited instantly with no output), while the
   * same image runs fine when the entrypoint is passed at start. Declaring
   * it here makes every start — including ensureStarted — pass it.
   */
  entrypoint = ["/container-start"];
  /** Idle instances sleep; the shim has already synced state by then. */
  sleepAfter = "15m";
  /** Must stay on: the sender's SMTP/IMAP egress uses non-HTTP ports. */
  enableInternet = true;

  private starting: Promise<void> | null = null;

  /**
   * The SDK tracks the activity deadline in memory (`sleepAfterMs`). After
   * the Durable Object is evicted — which can happen within the 1s startup
   * alarm — that field resets to 0 and the default `onActivityExpired()`
   * stops a healthy container seconds after it started. Derive liveness
   * from the persisted state instead: only sleep once the container has
   * genuinely been idle for `sleepAfter`.
   */
  override async onActivityExpired(): Promise<void> {
    const state = await this.getState();
    const aliveMs = Date.now() - (state.lastChange ?? Date.now());
    const sleepMs = 15 * 60 * 1000;
    if (state.status === "running" || state.status === "healthy") {
      if (aliveMs < sleepMs) {
        await this.scheduleNextAlarm(sleepMs - aliveMs);
        return;
      }
      await this.stop();
    }
  }

  /**
   * The container's only way to reach R2: plain HTTP to a virtual hostname,
   * resolved here in the Workers runtime. Keys arrive already prefixed with
   * the workspace by the shim (its WORKSPACE_ID is set by this class, never
   * by a request).
   */
  static outboundByHost = {
  [STATE_HOST]: async (request: Request, env: Env): Promise<Response> => {
    const key = new URL(request.url).pathname.replace(/^\/+/, "");
    const segment = /^[A-Za-z0-9][A-Za-z0-9/._-]*$/;
    if (!key || !segment.test(key) || key.split("/").includes("..")) {
      return new Response("bad key", { status: 400 });
    }
    if (request.method === "GET") {
      const object = await env.CRM.get(key);
      if (!object) return new Response("not found", { status: 404 });
      return new Response(object.body, {
        headers: {
          "content-type": "application/octet-stream",
          etag: object.httpEtag,
        },
      });
    }
    if (request.method === "PUT") {
      if (!request.body) return new Response("body required", { status: 400 });
      await env.CRM.put(key, request.body, {
        httpMetadata: { contentType: "application/octet-stream" },
      });
      return new Response(null, { status: 204 });
    }
    return new Response("method not allowed", { status: 405 });
  },
  };

  // ── per-workspace configuration, held in Durable Object storage ──

  private async stored(): Promise<StoredConfig | null> {
    return (await this.ctx.storage.get<StoredConfig>("config")) ?? null;
  }

  /** Called by the Worker (trusted) — never reachable from a request path. */
  async setConfig(ws: string, env: Record<string, string>): Promise<{ ok: true; keys: number; restarted: boolean }> {
    await this.ctx.storage.put("config", { ws, env });
    const state = await this.getState();
    const running = state.status === "running" || state.status === "healthy" || state.status === "stopping";
    if (running) {
      // The shim applies the environment at process start; a config change
      // mid-run aborts the run (state is synced; verbs are resumable).
      await this.stop();
    }
    return { ok: true, keys: Object.keys(env).length, restarted: running };
  }

  async getConfig(): Promise<{ ws: string; keys: string[] } | null> {
    const config = await this.stored();
    return config ? { ws: config.ws, keys: Object.keys(config.env).sort() } : null;
  }

  private async ensureStarted(): Promise<void> {
    const state = await this.getState();
    if (state.status === "running" || state.status === "healthy") return;
    if (!this.starting) {
      this.starting = (async () => {
        const config = (await this.stored()) ?? { ws: "unknown", env: {} };
        // startAndWaitForPorts with an explicit, generous budget: a bare
        // start() races the platform's scheduling window and can hang on a
        // monitor wait until the instance stops. Cold boots legitimately take
        // tens of seconds (state restore + migrate) before :8080 answers.
        await this.startAndWaitForPorts({
          startOptions: { envVars: { ...config.env, WORKSPACE_ID: config.ws } },
          cancellationOptions: { portReadyTimeoutMS: 90_000, waitInterval: 1_000 },
        });
      })().finally(() => {
        this.starting = null;
      });
    }
    await this.starting;
  }

  /** Debug: start with a long sleep so an operator can SSH in. */
  async debugSleep(): Promise<void> {
    await this.start({ entrypoint: ["/bin/sh", "-c", "sleep 900"] });
  }

  /** Debug: heartbeat + the real entrypoint, reporting via the public URL. */
  async debugNet(): Promise<void> {
    await this.start({
      entrypoint: ["/bin/sh", "-c", [
        `(while true; do curl -sS -m 5 "https://openoutreach.appifex-ai.workers.dev/net-report?hb=\$(date +%s)" >/dev/null 2>&1; sleep 5; done) &`,
        `exec /container-start`,
      ].join(" ")],
    });
  }

  /** Internal ingress from the Worker: forward to the shim on :8080. */
  override async fetch(request: Request): Promise<Response> {
    const config = await this.stored();
    if (!config) {
      return Response.json(
        { error: "workspace_not_configured", message: "PUT /w/<ws>/config first" },
        { status: 404 },
      );
    }
    await this.ensureStarted();
    return this.containerFetch(request);
  }
}

// ── the Worker's public surface ─────────────────────────────────────

function unauthorized(): Response {
  return new Response("unauthorized", { status: 401 });
}

async function forwardToWorkspace(request: Request, env: Env, ws: string, path: string): Promise<Response> {
  const stub = getContainer(env.OUTREACH, ws);
  const url = new URL(request.url);
  const init: RequestInit = {
    method: request.method,
    headers: { "content-type": request.headers.get("content-type") ?? "application/octet-stream" },
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }
  return stub.fetch(new Request(`https://engine${path}${url.search}`, init));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return Response.json({
        service: "openoutreach-engine",
        model: "one named container instance per workspace; R2 holds the CRM",
        endpoints: [
          "PUT  /w/<ws>/config            — the OUTSEND_* environment for this workspace",
          "GET  /w/<ws>/config            — which keys are set (values never returned)",
          "POST /w/<ws>/ingest            — JSON Lines body: leads in, upserted on lead_id",
          "POST /w/<ws>/send              — {n?} start a sending pass (--agent-draft)",
          "POST /w/<ws>/draft             — {subject, body} answer the pending draft",
          "GET  /w/<ws>/pending           — job phase, draft payload, last ingest/check",
          "POST /w/<ws>/check             — verify config incl. a real SMTP login",
          "GET  /w/<ws>/crm/leads         — leads with deal state and suppression",
          "GET  /w/<ws>/crm/conversations — the mail log, newest first",
          "GET  /w/<ws>/crm/mailbox       — connected mailboxes (no credentials)",
          "GET  /w/<ws>/db                — the SQLite file itself",
        ],
        note: "everything but / needs Authorization: Bearer <OUTREACH_SERVICE_TOKEN>",
      });
    }

    const authorized =
      env.OUTREACH_SERVICE_TOKEN !== undefined &&
      request.headers.get("authorization") === `Bearer ${env.OUTREACH_SERVICE_TOKEN}`;
    if (!authorized) return unauthorized();

    const match = url.pathname.match(/^\/w\/([^/]+)(\/.*)?$/);
    if (!match) return new Response("not found", { status: 404 });
    const ws = match[1];
    if (!WS_PATTERN.test(ws)) return new Response("bad workspace id", { status: 400 });
    const path = match[2] ?? "/";

    // Configuration is Durable Object RPC, not a shim route.
    if (path === "/config") {
      const stub = getContainer(env.OUTREACH, ws);
      if (request.method === "GET") {
        const config = await stub.getConfig();
        return config ? Response.json(config) : Response.json({ keys: [] }, { status: 404 });
      }
      if (request.method === "PUT") {
        let payload: { env?: unknown };
        try {
          payload = await request.json();
        } catch {
          return Response.json({ error: "bad_json" }, { status: 400 });
        }
        const envMap = payload.env;
        if (typeof envMap !== "object" || envMap === null || Array.isArray(envMap)) {
          return Response.json({ error: "bad_env", message: "expected {env: {...}}" }, { status: 400 });
        }
        const entries = Object.entries(envMap as Record<string, unknown>);
        if (entries.length === 0 || entries.length > MAX_ENV_KEYS) {
          return Response.json({ error: "bad_env", message: `1..${MAX_ENV_KEYS} keys` }, { status: 400 });
        }
        const clean: Record<string, string> = {};
        for (const [key, value] of entries) {
          if (!ENV_PATTERN.test(key)) {
            return Response.json({ error: "bad_env", message: `${key}: OUTSEND_* keys only` }, { status: 400 });
          }
          if (typeof value !== "string" || value.length > MAX_ENV_VALUE) {
            return Response.json({ error: "bad_env", message: `${key}: string ≤ ${MAX_ENV_VALUE} chars` }, { status: 400 });
          }
          if (value !== "") clean[key] = value;
        }
        return Response.json(await stub.setConfig(ws, clean));
      }
      return new Response("method not allowed", { status: 405 });
    }

    // The database file is served straight from R2 — no container needed.
    if (path === "/db" && request.method === "GET") {
      const object = await env.CRM.get(`crm/${ws}/db.sqlite3`);
      if (!object) return new Response("no database yet", { status: 404 });
      return new Response(object.body, {
        headers: { "content-type": "application/octet-stream", etag: object.httpEtag },
      });
    }

    // Debug route: start this workspace's container with a shell entrypoint
    // so `wrangler containers ssh` can get in and run /container-start by
    // hand. Not part of the engine contract; remove once boot is understood.
    if (path === "/debug-sleep" && request.method === "POST") {
      const stub = getContainer(env.OUTREACH, ws);
      const config = await stub.getConfig();
      if (!config) return Response.json({ error: "workspace_not_configured" }, { status: 404 });
      await stub.debugSleep();
      return Response.json({ started: true, entrypoint: "sleep 900" });
    }

    // Debug: network probe receiver — the container reports its egress test
    // results here through the public internet path. Remove once boot works.
    if (url.pathname === "/net-report") {
      console.log("NET-REPORT", url.search);
      return new Response("ok");
    }

    if (url.pathname === "/debug-net" && request.method === "POST") {
      const stub = getContainer(env.OUTREACH, ws);
      const config = await stub.getConfig();
      if (!config) return Response.json({ error: "workspace_not_configured" }, { status: 404 });
      await stub.debugNet();
      return Response.json({ started: true });
    }

    return forwardToWorkspace(request, env, ws, path);
  },
};
