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
// The API speaks in a workspace's own terms — a sender, a campaign, a pool
// of mailboxes — and this file is the one place that translates them into the
// sender's OUTSEND_* vocabulary. Callers never see a variable name.
//
// The rules:
//  - one job per database, ever — the Durable Object per workspace is the
//    mutex, and the shim serializes CLI runs inside the container;
//  - credentials live in the workspace's Durable Object and nowhere else:
//    not in the image, not in R2 (the shim uploads the database with
//    mailbox passwords blanked), never in a response;
//  - the R2 credentials never enter the container — state traffic rides
//    the outbound proxy on the virtual hostname state.internal, and each
//    container may only touch its own workspace's prefix.

import { Container, ContainerProxy, getContainer } from "@cloudflare/containers";
import type { OutboundHandlerContext } from "@cloudflare/containers";

// Required for outbound interception to work.
export { ContainerProxy };

/** Virtual hostname the shim's state sync talks to; routed to R2. */
const STATE_HOST = "state.internal";

/** Workspace ids: slack-style slugs or voki's cuids, safe as R2 key segments and DO names. */
const WS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ADDRESS_PATTERN = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/;

const MAX_DOC = 20_000; // product docs are pages of markdown
const MAX_MAILBOXES = 25;

/** Google Workspace, the sender's own defaults — what a box with no transport uses. */
const GMAIL = { smtp_host: "smtp.gmail.com", smtp_port: 587, imap_host: "imap.gmail.com", imap_port: 993 };

// ── the workspace model ─────────────────────────────────────────────

interface Sender {
  name: string;
  email?: string;
  country?: string;
}

interface Campaign {
  product: string;
  target: string;
  booking_link?: string;
}

interface Mailbox {
  app_password: string;
  smtp_host: string;
  smtp_port: number;
  imap_host: string;
  imap_port: number;
  signature?: string;
  /** No new conversations and no follow-ups; replies on its threads still flow. */
  retired?: boolean;
  /** Set when the credentials changed; cleared once an SMTP login accepts them. */
  verify?: boolean;
}

interface Workspace {
  ws: string;
  sender?: Sender;
  campaign?: Campaign;
  mailboxes: Record<string, Mailbox>;
}

interface Patch {
  sender?: Sender;
  campaign?: Campaign;
  mailboxes?: Record<string, Mailbox | "retire">;
}

/** Sender-side names in the shim's messages, in the API's own words. */
const VOCABULARY: Record<string, string> = {
  OUTSEND_OPERATOR_NAME: "sender.name",
  OUTSEND_OPERATOR_EMAIL: "sender.email",
  OUTSEND_PRODUCT_DOCS: "campaign.product",
  OUTSEND_CAMPAIGN_TARGET: "campaign.target",
  OUTSEND_MAILBOX_ADDRESS: "mailboxes",
  OUTSEND_MAILBOX_PASSWORD: "mailboxes",
};

function translate(text: string): string {
  let out = text;
  for (const [variable, name] of Object.entries(VOCABULARY)) out = out.split(variable).join(name);
  return out.replace(/mailboxes, mailboxes/g, "mailboxes");
}

/** The sender's environment for this workspace — the only place OUTSEND_* is spelled. */
function environmentFor(w: Workspace): Record<string, string> {
  const env: Record<string, string> = { WORKSPACE_ID: w.ws };
  const set = (key: string, value: string | undefined) => {
    if (value) env[key] = value;
  };
  set("OUTSEND_OPERATOR_NAME", w.sender?.name);
  set("OUTSEND_OPERATOR_EMAIL", w.sender?.email);
  set("OUTSEND_OPERATOR_COUNTRY", w.sender?.country);
  set("OUTSEND_PRODUCT_DOCS", w.campaign?.product);
  set("OUTSEND_CAMPAIGN_TARGET", w.campaign?.target);
  set("OUTSEND_BOOKING_LINK", w.campaign?.booking_link);
  // Not the sender's one-box variables: the shim reconciles the whole pool.
  env.ENGINE_MAILBOXES = JSON.stringify(
    Object.entries(w.mailboxes).map(([address, box]) => ({ address, ...box })),
  );
  return env;
}

function missing(w: Workspace | null): string[] {
  const out: string[] = [];
  if (!w?.sender) out.push("sender");
  if (!w?.campaign) out.push("campaign");
  if (!w || !Object.values(w.mailboxes).some((box) => !box.retired)) out.push("mailboxes");
  return out;
}

/** What a caller may see: everything but credentials. */
function describe(ws: string, w: Workspace | null) {
  const needs = missing(w);
  return {
    workspace: ws,
    ready: needs.length === 0,
    missing: needs,
    sender: w?.sender ?? null,
    campaign: w?.campaign
      ? { product_chars: w.campaign.product.length, target_chars: w.campaign.target.length,
          booking_link: w.campaign.booking_link ?? null }
      : null,
    mailboxes: Object.entries(w?.mailboxes ?? {}).map(([address, box]) => ({
      address,
      smtp: `${box.smtp_host}:${box.smtp_port}`,
      imap: `${box.imap_host}:${box.imap_port}`,
      retired: Boolean(box.retired),
    })),
  };
}

// ── validation: request bodies into the model ───────────────────────

class BadRequest extends Error {}

function text(value: unknown, field: string, max: number, required = true): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) throw new BadRequest(`${field} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new BadRequest(`${field} must be a string`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new BadRequest(`${field} is required`);
  if (trimmed.length > max) throw new BadRequest(`${field} must be ≤ ${max} characters`);
  return trimmed || undefined;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BadRequest(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function address(value: unknown): string {
  const a = text(value, "address", 320)!.toLowerCase();
  if (!ADDRESS_PATTERN.test(a)) throw new BadRequest(`${a} is not an email address`);
  return a;
}

function port(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65535) {
    throw new BadRequest(`${field} must be a port number`);
  }
  return value as number;
}

function parseSender(value: unknown): Sender {
  const v = object(value, "sender");
  const email = text(v.email, "sender.email", 320, false);
  if (email && !ADDRESS_PATTERN.test(email)) throw new BadRequest("sender.email is not an email address");
  return {
    name: text(v.name, "sender.name", 200)!,
    email: email?.toLowerCase(),
    country: text(v.country, "sender.country", 60, false),
  };
}

function parseCampaign(value: unknown): Campaign {
  const v = object(value, "campaign");
  const link = text(v.booking_link, "campaign.booking_link", 500, false);
  if (link && !/^https?:\/\//.test(link)) throw new BadRequest("campaign.booking_link must be an http(s) URL");
  return {
    product: text(v.product, "campaign.product", MAX_DOC)!,
    target: text(v.target, "campaign.target", MAX_DOC)!,
    booking_link: link,
  };
}

function parseMailbox(value: unknown, field: string): Mailbox {
  const v = object(value, field);
  const box: Mailbox = {
    app_password: text(v.app_password, `${field}.app_password`, 200)!,
    ...GMAIL,
    verify: true,
  };
  if (v.smtp !== undefined) {
    const smtp = object(v.smtp, `${field}.smtp`);
    box.smtp_host = text(smtp.host, `${field}.smtp.host`, 255)!;
    box.smtp_port = port(smtp.port, `${field}.smtp.port`);
  }
  if (v.imap !== undefined) {
    const imap = object(v.imap, `${field}.imap`);
    box.imap_host = text(imap.host, `${field}.imap.host`, 255)!;
    box.imap_port = port(imap.port, `${field}.imap.port`);
  }
  if (v.signature !== undefined && v.signature !== null) {
    if (typeof v.signature !== "string" || v.signature.length > 2000) {
      throw new BadRequest(`${field}.signature must be a string ≤ 2000 characters`);
    }
    box.signature = v.signature;
  }
  return box;
}

/** PUT /w/<ws>: any of the three sections, mailboxes as a list. */
function parseWorkspace(value: unknown): Patch {
  const v = object(value, "body");
  const patch: Patch = {};
  if (v.sender !== undefined) patch.sender = parseSender(v.sender);
  if (v.campaign !== undefined) patch.campaign = parseCampaign(v.campaign);
  if (v.mailboxes !== undefined) {
    if (!Array.isArray(v.mailboxes)) throw new BadRequest("mailboxes must be a list");
    patch.mailboxes = {};
    v.mailboxes.forEach((entry, i) => {
      const a = address(object(entry, `mailboxes[${i}]`).address);
      patch.mailboxes![a] = parseMailbox(entry, `mailboxes[${i}]`);
    });
  }
  if (!patch.sender && !patch.campaign && !patch.mailboxes) {
    throw new BadRequest("expected at least one of sender, campaign, mailboxes");
  }
  return patch;
}

// ── the state store ─────────────────────────────────────────────────

/**
 * The container's only way to reach R2: plain HTTP to a virtual hostname,
 * resolved here in the Workers runtime. A container may only touch its own
 * workspace's prefix — the key's workspace must name the Durable Object the
 * request came from.
 */
async function stateStore(request: Request, env: Env, ctx: OutboundHandlerContext): Promise<Response> {
  const key = new URL(request.url).pathname.replace(/^\/+/, "");
  const segment = /^[A-Za-z0-9][A-Za-z0-9/._-]*$/;
  if (!key || !segment.test(key) || key.split("/").includes("..")) {
    return new Response("bad key", { status: 400 });
  }
  const [root, ws] = key.split("/");
  if (root !== "crm" || !ws || env.OUTREACH.idFromName(ws).toString() !== ctx.containerId) {
    console.error("state", request.method, key, "refused: outside this container's workspace");
    return new Response("forbidden", { status: 403 });
  }
  try {
    if (request.method === "GET") {
      const object = await env.CRM.get(key);
      console.log("state", "GET", key, object ? object.size : 404);
      if (!object) return new Response("not found", { status: 404 });
      return new Response(object.body, {
        headers: {
          "content-type": "application/octet-stream",
          etag: object.httpEtag,
        },
      });
    }
    if (request.method === "PUT") {
      // Buffered, not streamed: R2 rejects a stream of unknown length,
      // and a body arriving through the interception proxy carries none.
      const body = await request.arrayBuffer();
      await env.CRM.put(key, body, {
        httpMetadata: { contentType: "application/octet-stream" },
      });
      console.log("state", "PUT", key, body.byteLength);
      return new Response(null, { status: 204 });
    }
    return new Response("method not allowed", { status: 405 });
  } catch (error) {
    // Logged here, because the caller in the container cannot be heard.
    console.error("state", request.method, key, "failed:", String(error));
    return new Response(`state store error: ${error}`, { status: 502 });
  }
}

export interface Env {
  OUTREACH: DurableObjectNamespace<OutreachContainer>;
  CRM: R2Bucket;
  OUTREACH_SERVICE_TOKEN?: string;
}

// ── the per-workspace container ─────────────────────────────────────

export class OutreachContainer extends Container {
  /** The shim's HTTP surface; readiness is the port accepting connections. */
  defaultPort = 8080;
  requiredPorts = [8080];
  /** The image's own ENTRYPOINT, stated so every start passes it explicitly. */
  entrypoint = ["/container-start"];
  /** Idle instances sleep; the shim has already synced state by then. */
  sleepAfter = "15m";
  /** Must stay on: the sender's SMTP/IMAP egress uses non-HTTP ports. */
  enableInternet = true;

  private starting: Promise<void> | null = null;

  /**
   * The SDK tracks the activity deadline in Durable Object memory
   * (`sleepAfterMs`), and the default `onActivityExpired()` stops the
   * container on it alone. Derive liveness from the persisted state too:
   * only sleep once the container has genuinely been idle for `sleepAfter`.
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

  private async load(): Promise<Workspace | null> {
    return (await this.ctx.storage.get<Workspace>("workspace")) ?? null;
  }

  /** Called by the Worker (trusted): what the workspace is, without credentials. */
  async status(ws: string) {
    return describe(ws, await this.load());
  }

  /**
   * Called by the Worker (trusted): apply a patch and, when mailbox
   * credentials changed, prove them. The container applies configuration at
   * start, so a change restarts it; new credentials are then checked by the
   * sender's own SMTP-login gate during that start. A box whose login is
   * refused is not kept — the previous credentials (or no box) stand.
   */
  async update(ws: string, patch: Patch) {
    const previous = (await this.load()) ?? { ws, mailboxes: {} };
    const next: Workspace = structuredClone(previous);
    next.ws = ws;
    if (patch.sender) next.sender = patch.sender;
    if (patch.campaign) next.campaign = patch.campaign;
    for (const [address, change] of Object.entries(patch.mailboxes ?? {})) {
      if (change === "retire") {
        if (next.mailboxes[address]) next.mailboxes[address] = { ...next.mailboxes[address], retired: true, verify: false };
      } else {
        next.mailboxes[address] = change;
      }
    }
    if (Object.keys(next.mailboxes).length > MAX_MAILBOXES) {
      throw new BadRequest(`at most ${MAX_MAILBOXES} mailboxes per workspace`);
    }
    await this.ctx.storage.put("workspace", next);
    await this.restart();

    const rejected: { address: string; reason: string }[] = [];
    const checking = Object.entries(next.mailboxes).filter(([, box]) => box.verify);
    if (checking.length > 0) {
      await this.ensureStarted();
      const response = await this.containerFetch(new Request("http://engine/mailboxes"));
      const results = ((await response.json()) as { mailboxes: { address: string; ok: boolean; reason?: string }[] }).mailboxes;
      for (const [address] of checking) {
        const result = results.find((r) => r.address === address);
        if (result?.ok) {
          next.mailboxes[address].verify = false;
          continue;
        }
        rejected.push({ address, reason: result?.reason ?? "not reached" });
        if (previous.mailboxes[address]) next.mailboxes[address] = previous.mailboxes[address];
        else delete next.mailboxes[address];
      }
      await this.ctx.storage.put("workspace", next);
      // The running instance was started with the refused credentials.
      if (rejected.length > 0) await this.restart();
    }
    return { ...describe(ws, next), rejected };
  }

  /**
   * Called by the Worker (trusted): drop this workspace's configuration and
   * kill its container. SIGKILL, not SIGTERM — a graceful stop would sync
   * state back to R2 just as the Worker deletes it.
   */
  async forget(): Promise<{ configured: boolean; wasRunning: boolean }> {
    const configured = (await this.load()) !== null;
    const wasRunning = Boolean(this.ctx.container?.running);
    if (wasRunning) await this.destroy();
    await this.ctx.storage.delete("workspace");
    return { configured, wasRunning };
  }

  /**
   * Stop a running instance and wait until it is gone, so the next start
   * applies the stored configuration. A run in progress is aborted (state
   * is synced on SIGTERM; verbs are resumable).
   */
  private async restart(): Promise<void> {
    if (!this.ctx.container?.running) return;
    await this.stop();
    for (let i = 0; i < 90 && this.ctx.container.running; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  private async ensureStarted(): Promise<void> {
    const state = await this.getState();
    if (state.status === "running" || state.status === "healthy") return;
    if (!this.starting) {
      this.starting = (async () => {
        const workspace = await this.load();
        if (!workspace) throw new Error("workspace not configured");
        // startAndWaitForPorts with an explicit, generous budget: a bare
        // start() races the platform's scheduling window and can hang on a
        // monitor wait until the instance stops. Cold boots legitimately take
        // tens of seconds (restore + migrate + mailbox logins) before :8080 answers.
        await this.startAndWaitForPorts({
          startOptions: { envVars: environmentFor(workspace) },
          cancellationOptions: { portReadyTimeoutMS: 120_000, waitInterval: 1_000 },
        });
      })().finally(() => {
        this.starting = null;
      });
    }
    await this.starting;
  }

  /** Internal ingress from the Worker: forward to the shim on :8080. */
  override async fetch(request: Request): Promise<Response> {
    if (!(await this.load())) {
      return Response.json(
        { error: "workspace_not_configured", message: "PUT /w/<ws> first" },
        { status: 404 },
      );
    }
    await this.ensureStarted();
    return this.containerFetch(request);
  }
}

// Registered by assignment, never as a `static outboundByHost = …` class
// field: a class field is *defined* on the subclass, shadowing the SDK's
// static setter, so the handler never reaches the registry ContainerProxy
// reads. The host is still intercepted (the constructor sees the own
// property) and the request falls through to the public internet, where
// state.internal does not resolve — every restore fails and every upload
// vanishes. That was the whole 2026-10-04 "platform" incident.
OutreachContainer.outboundByHost = { [STATE_HOST]: stateStore };

// ── the Worker's public surface ─────────────────────────────────────

/** Workspace routes served by the shim, keyed by the public path. */
const SHIM_ROUTES: Record<string, string> = {
  "POST /leads": "/leads",
  "POST /send": "/send",
  "POST /draft": "/draft",
  "POST /check": "/check",
  "GET /pending": "/pending",
  "GET /mailboxes": "/mailboxes",
  "GET /crm/leads": "/crm/leads",
  "GET /crm/conversations": "/crm/conversations",
};

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
  const response = await stub.fetch(new Request(`https://engine${path}${url.search}`, init));
  if (path !== "/check" && path !== "/pending") return response;
  // The sender's messages name its variables; the caller knows the API's fields.
  return new Response(translate(await response.text()), {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
}

async function body(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new BadRequest("body must be JSON");
  }
}

async function purge(env: Env, ws: string): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await env.CRM.list({ prefix: `crm/${ws}/`, cursor });
    if (page.objects.length > 0) {
      await env.CRM.delete(page.objects.map((o) => o.key));
      deleted += page.objects.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}

async function route(request: Request, env: Env, ws: string, path: string): Promise<Response> {
  const stub = getContainer(env.OUTREACH, ws);
  const method = request.method;
  const updated = (result: Awaited<ReturnType<typeof stub.update>>) =>
    Response.json(
      result.rejected.length > 0 ? { error: "mailbox_rejected", ...result } : result,
      { status: result.rejected.length > 0 ? 422 : 200 },
    );

  if (path === "/") {
    if (method === "GET") return Response.json(await stub.status(ws));
    if (method === "PUT") return updated(await stub.update(ws, parseWorkspace(await body(request))));
    if (method === "DELETE") {
      // Irreversible: configuration, container and the database with it.
      const forgotten = await stub.forget();
      return Response.json({ ...forgotten, objectsDeleted: await purge(env, ws) });
    }
  }
  if (path === "/sender" && method === "PUT") {
    return updated(await stub.update(ws, { sender: parseSender(await body(request)) }));
  }
  if (path === "/campaign" && method === "PUT") {
    return updated(await stub.update(ws, { campaign: parseCampaign(await body(request)) }));
  }
  const box = path.match(/^\/mailboxes\/([^/]+)$/);
  if (box) {
    const a = address(decodeURIComponent(box[1]));
    if (method === "PUT") {
      return updated(await stub.update(ws, { mailboxes: { [a]: parseMailbox(await body(request), "mailbox") } }));
    }
    if (method === "DELETE") return updated(await stub.update(ws, { mailboxes: { [a]: "retire" } }));
  }

  // The database file is served straight from R2 — no container needed,
  // and no credentials in it (the shim blanks them before every upload).
  if (path === "/db" && method === "GET") {
    const object = await env.CRM.get(`crm/${ws}/db.sqlite3`);
    if (!object) return new Response("no database yet", { status: 404 });
    return new Response(object.body, {
      headers: { "content-type": "application/octet-stream", etag: object.httpEtag },
    });
  }

  const shimPath = SHIM_ROUTES[`${method} ${path}`];
  if (shimPath) return forwardToWorkspace(request, env, ws, shimPath);
  return Response.json({ error: "not_found" }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return Response.json({
        service: "openoutreach-engine",
        model: "one named container instance per workspace; R2 holds the CRM",
        endpoints: [
          "GET    /w/<ws>                     — ready?, what is missing, the settings (never credentials)",
          "PUT    /w/<ws>                     — {sender?, campaign?, mailboxes?: [...]} — onboarding in one call",
          "DELETE /w/<ws>                     — forget the workspace: settings, container, database",
          "PUT    /w/<ws>/sender              — {name, email?, country?}",
          "PUT    /w/<ws>/campaign            — {product, target, booking_link?}",
          "PUT    /w/<ws>/mailboxes/<address> — {app_password, smtp?, imap?, signature?} — login verified",
          "DELETE /w/<ws>/mailboxes/<address> — retire: no new conversations, replies still flow",
          "GET    /w/<ws>/mailboxes           — each box: connected?, daily limit, next send",
          "POST   /w/<ws>/leads               — JSON Lines body: leads in, upserted on lead_id",
          "POST   /w/<ws>/send                — {n?} start a sending pass (--agent-draft)",
          "POST   /w/<ws>/draft               — {subject, body} answer the pending draft",
          "GET    /w/<ws>/pending             — job phase, draft payload, last ingest/check",
          "POST   /w/<ws>/check               — verify the workspace can send",
          "GET    /w/<ws>/crm/leads           — leads with deal state and suppression",
          "GET    /w/<ws>/crm/conversations   — the mail log, newest first",
          "GET    /w/<ws>/db                  — the SQLite file itself (no credentials)",
        ],
        note: "everything but / needs Authorization: Bearer <OUTREACH_SERVICE_TOKEN>",
      });
    }

    const authorized =
      env.OUTREACH_SERVICE_TOKEN !== undefined &&
      request.headers.get("authorization") === `Bearer ${env.OUTREACH_SERVICE_TOKEN}`;
    if (!authorized) return new Response("unauthorized", { status: 401 });

    const match = url.pathname.match(/^\/w\/([^/]+)(\/.*)?$/);
    if (!match) return Response.json({ error: "not_found" }, { status: 404 });
    const ws = match[1];
    if (!WS_PATTERN.test(ws)) return Response.json({ error: "bad_workspace_id" }, { status: 400 });

    try {
      return await route(request, env, ws, match[2] ?? "/");
    } catch (error) {
      // BadRequest crosses the RPC boundary as a plain Error carrying its message.
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof BadRequest || /required|must be|not an email|at most|expected/.test(message)) {
        return Response.json({ error: "bad_request", message }, { status: 400 });
      }
      throw error;
    }
  },
};
