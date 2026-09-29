// src/index.ts — the Worker half of the Cloudflare deploy (docs/cloudflare.md).
//
// What this code is: a cron trigger and four small HTTP endpoints around one
// bounded job. What it deliberately is not: a web surface for OpenOutreach —
// the product's contract stays "one job, CSV out, the DB is the truth", and
// this Worker only starts and watches that job.
//
// The pieces, and why:
//  - the Durable Object is the mutex. Cron and the HTTP endpoints address one
//    *named* container instance, so "one job per database, ever" is enforced
//    by construction, the way the VM deploy enforces it with a systemd timer.
//  - the R2 binding never enters the container. The job's state-sync script
//    speaks plain HTTP to the virtual hostname state.internal, and the
//    outboundByHost handler below resolves that against R2 — credentials stay
//    in the Worker's environment.
//  - enableInternet stays true on purpose: the sender's SMTP/IMAP egress uses
//    non-HTTP ports, which outbound handlers cannot proxy.

import { Container, ContainerProxy, getContainer } from "@cloudflare/containers";

// Required for outbound interception to work.
export { ContainerProxy };

/** Virtual hostname the container's state-sync script talks to; routed to R2. */
const STATE_HOST = "state.internal";

/** The singleton instance name: one job per database, ever. */
const INSTANCE = "openoutreach";

/**
 * Worker secrets passed through to the container on every start, when set.
 * These are the two children's own vocabularies (openoutreach/config/models.py
 * is the mapping) — the job exits naming any it lacks, which is the contract.
 */
const PASSTHROUGH = [
  "OPENOUTFIND_PRODUCT_DOCS",
  "OPENOUTFIND_CAMPAIGN_TARGET",
  "OPENOUTFIND_AI_MODEL",
  "OPENOUTFIND_LLM_API_KEY",
  "OPENOUTFIND_LLM_API_BASE",
  "OPENOUTFIND_BETTERCONTACT_API_KEY",
  "OPENOUTFIND_APOLLO_API_KEY",
  "OPENOUTFIND_EMAIL_FINDER",
  "OPENOUTFIND_OPERATOR_EMAIL",
  "OPENOUTFIND_OPERATOR_NAME",
  "OPENOUTFIND_OPERATOR_COUNTRY",
  "OPENOUTFIND_CONTACTS_API_TOKEN",
  "OPENOUTFIND_NEWSLETTER",
  "OUTSEND_PRODUCT_DOCS",
  "OUTSEND_CAMPAIGN_TARGET",
  "OUTSEND_BOOKING_LINK",
  "OUTSEND_AI_MODEL",
  "OUTSEND_LLM_API_KEY",
  "OUTSEND_LLM_API_BASE",
  "OUTSEND_OPERATOR_NAME",
  "OUTSEND_OPERATOR_EMAIL",
  "OUTSEND_OPERATOR_COUNTRY",
  "OUTSEND_MAILBOX_ADDRESS",
  "OUTSEND_MAILBOX_PASSWORD",
  "OUTSEND_SMTP_HOST",
  "OUTSEND_SMTP_PORT",
  "OUTSEND_IMAP_HOST",
  "OUTSEND_IMAP_PORT",
  "OUTSEND_SIGNATURE",
] as const;

export interface Env {
  OUTREACH: DurableObjectNamespace<OutreachContainer>;
  CRM: R2Bucket;
  RUN_TOKEN?: string;
  OPENOUTREACH_GOAL?: string;
  OPENOUTREACH_UNIT?: string;
  OPENOUTREACH_SEND?: string;
}

function containerEnv(env: Env): Record<string, string> {
  const source = env as unknown as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of PASSTHROUGH) {
    const value = source[key];
    if (typeof value === "string" && value !== "") out[key] = value;
  }
  return out;
}

export class OutreachContainer extends Container {
  /** A bounded job, not a server: no ports to serve, nothing to keep alive. */
  sleepAfter = "2m";
  /** Must stay on: SMTP/IMAP leave on ports the outbound proxy cannot carry. */
  enableInternet = true;

  /**
   * The container's only way to reach R2: plain HTTP to a virtual hostname,
   * resolved here in the Workers runtime. The container never sees a
   * credential, and the CRM's bytes never leave Cloudflare's network.
   */
  static outboundByHost = {
    [STATE_HOST]: async (request: Request, env: Env): Promise<Response> => {
      const key = new URL(request.url).pathname.replace(/^\/+/, "");
      if (!key || key.includes("..")) {
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

  override onStart(): void {
    console.log("[openoutreach] container started");
  }

  override onStop({ exitCode, reason }: { exitCode?: number; reason?: string }): void {
    console.log("[openoutreach] job finished", { exitCode, reason });
    void this.ctx.storage.put("lastRun", {
      exitCode: exitCode ?? null,
      reason: reason ?? null,
      at: new Date().toISOString(),
    });
  }

  override onError(error: unknown): void {
    console.error("[openoutreach] container error", error);
  }

  /** Read by GET /status through the Durable Object stub. */
  async lastRun(): Promise<{ exitCode: number | null; reason: string | null; at: string } | null> {
    return (await this.ctx.storage.get("lastRun")) ?? null;
  }
}

async function startJob(env: Env, goal: string, unit: string): Promise<Response> {
  const container = getContainer(env.OUTREACH, INSTANCE);
  const state = await container.getState();
  if (state.status !== "stopped" && state.status !== "stopped_with_code") {
    return Response.json({ started: false, state }, { status: 409 });
  }
  await container.start({
    envVars: {
      ...containerEnv(env),
      OPENOUTREACH_GOAL: goal,
      OPENOUTREACH_UNIT: unit,
    },
  });
  console.log("[openoutreach] job started", { goal, unit });
  return Response.json({ started: true, goal, unit });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const authorized =
      env.RUN_TOKEN !== undefined &&
      request.headers.get("authorization") === `Bearer ${env.RUN_TOKEN}`;

    if (url.pathname === "/") {
      return Response.json({
        service: "openoutreach",
        cron: "see wrangler.toml [triggers]",
        endpoints: ["GET /status", "POST /run?goal=10&unit=emails", "GET /leads", "GET /db"],
        note: "everything but / needs Authorization: Bearer <RUN_TOKEN>",
      });
    }

    if (!authorized) return new Response("unauthorized", { status: 401 });

    const container = getContainer(env.OUTREACH, INSTANCE);

    if (url.pathname === "/status" && request.method === "GET") {
      return Response.json({
        state: await container.getState(),
        lastRun: await container.lastRun(),
      });
    }

    if (url.pathname === "/run" && request.method === "POST") {
      const goal = url.searchParams.get("goal") ?? env.OPENOUTREACH_GOAL ?? "10";
      const unit = url.searchParams.get("unit") ?? env.OPENOUTREACH_UNIT ?? "emails";
      return startJob(env, goal, unit);
    }

    if (url.pathname === "/leads" && request.method === "GET") {
      const object = await env.CRM.get("leads.csv");
      if (!object) return new Response("no leads yet", { status: 404 });
      return new Response(object.body, {
        headers: { "content-type": "text/csv", etag: object.httpEtag },
      });
    }

    if (url.pathname === "/db" && request.method === "GET") {
      const object = await env.CRM.get("db.sqlite3");
      if (!object) return new Response("no database yet", { status: 404 });
      return new Response(object.body, {
        headers: { "content-type": "application/octet-stream", etag: object.httpEtag },
      });
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const container = getContainer(env.OUTREACH, INSTANCE);
    const state = await container.getState();
    if (state.status !== "stopped" && state.status !== "stopped_with_code") {
      console.log("[openoutreach] cron skipped, a job is already active:", state.status);
      return;
    }
    await container.start({
      envVars: {
        ...containerEnv(env),
        OPENOUTREACH_GOAL: env.OPENOUTREACH_GOAL ?? "10",
        OPENOUTREACH_UNIT: env.OPENOUTREACH_UNIT ?? "emails",
      },
    });
    console.log("[openoutreach] cron started the job");
  },
};
