import { type AuthConfig, AUTH_ENV, getSession } from "./auth.ts";
import type { JobOpts, NodeInfo } from "./commands.ts";
import { DEFAULT_WHITELIST, everyoneGrant, isApproved, whitelistFor } from "./perms.ts";
import { NODE_ID_RE, type State, USER_ID_RE } from "../shared/state.ts";
import type { CommandInfo } from "../shared/protocol.ts";

export interface Activity {
  t: number;
  user: string;
  via: "discord" | "dashboard";
  node: string;
  cmd: string;
  args: string;
  ok: boolean;
  ms: number;
}

export interface ConnectedNode {
  id: string;
  name: string;
  approved: boolean;
  commands?: CommandInfo[];
}

export interface DashCtx {
  cfg: AuthConfig | null;
  owners: Set<string>;
  envApproved: Set<string>;
  state(): State;
  mutate(fn: (s: State) => void): Promise<void>;
  connected(): ConnectedNode[];
  runJob(
    cmd: string,
    args: string[],
    opts?: JobOpts,
  ): Promise<{ node: NodeInfo; ok: boolean; output: string; ms: number }>;
  activity(): Activity[];
  userNames(): Record<string, string>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const COMMAND_RE = /^[a-z0-9_-]{1,32}$/;
let htmlCache: string | undefined;

async function dashboardHtml(): Promise<string> {
  return (htmlCache ??= await Deno.readTextFile(new URL("./dashboard.html", import.meta.url)));
}

function setupPage(): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Dashboard setup</title><body style="font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;line-height:1.5">` +
      `<h1>Dashboard not configured</h1><p>Set these on the hub (Replit secrets), then restart:</p><ul>` +
      [...AUTH_ENV, "OWNER_IDS"].map((k) => `<li><code>${k}</code></li>`).join("") +
      `</ul><p>See the README for where to find each value.</p>`,
    { status: 503, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function handleDashboard(req: Request, url: URL, ctx: DashCtx): Promise<Response | null> {
  const p = url.pathname;
  if (p !== "/dashboard" && !p.startsWith("/api/")) return null;
  if (!ctx.cfg || ctx.owners.size === 0) return p === "/dashboard" ? setupPage() : json({ error: "not configured" }, 503);

  const me = await getSession(req, ctx.cfg, ctx.owners);
  if (p === "/dashboard") {
    if (!me) return new Response(null, { status: 302, headers: { location: "/login" } });
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12))));
    return new Response((await dashboardHtml()).replaceAll("__NONCE__", nonce), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-frame-options": "DENY",
        "content-security-policy":
          `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      },
    });
  }

  // ---- JSON API: owner session required ----
  if (!me) return json({ error: "unauthorized" }, 401);
  const S = ctx.state();

  if (req.method === "GET" && p === "/api/state") {
    const conn = new Map(ctx.connected().map((n) => [n.id, n]));
    const ids = new Set<string>([...conn.keys(), ...S.approved, ...S.denied, ...ctx.envApproved]);
    const nodes = [...ids].sort().map((id) => {
      const c = conn.get(id);
      const status = S.denied.includes(id) ? "denied" : isApproved(S, ctx.envApproved, id) ? "approved" : "pending";
      return {
        id,
        name: c?.name ?? S.names[id] ?? id,
        online: !!c,
        status,
        envApproved: ctx.envApproved.has(id),
        commands: c?.commands ?? null,
        whitelist: whitelistFor(S, id),
        whitelistIsDefault: !S.whitelist[id],
      };
    });
    const names = ctx.userNames();
    const grants = [
      { user: "*", name: "Everyone", nodes: everyoneGrant(S).nodes, isDefault: !S.grants["*"] },
      ...Object.keys(S.grants).filter((u) => u !== "*").sort().map((u) => ({
        user: u,
        name: names[u] ?? null,
        nodes: S.grants[u].nodes,
        isDefault: false,
      })),
    ];
    return json({ me, nodes, grants, activity: ctx.activity().slice(0, 40), defaultWhitelist: DEFAULT_WHITELIST });
  }

  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  // CSRF: browsers can't send application/json cross-site without a CORS preflight we never answer; also check Origin.
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return json({ error: "expected JSON" }, 415);
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(ctx.cfg.publicUrl).origin) return json({ error: "bad origin" }, 403);
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad JSON" }, 400);
  }
  const id = typeof body.id === "string" ? body.id : "";
  const nodeOk = NODE_ID_RE.test(id);
  const bad = (msg: string) => json({ error: msg }, 400);

  if (p === "/api/node") {
    if (!nodeOk) return bad("bad node id");
    const action = body.action;
    if (action !== "approve" && action !== "deny" && action !== "revoke") return bad("bad action");
    const name = ctx.connected().find((n) => n.id === id)?.name;
    await ctx.mutate((s) => {
      const without = (a: string[]) => a.filter((x) => x !== id);
      if (action === "approve") {
        s.denied = without(s.denied);
        s.approved = [...without(s.approved), id];
        if (name) s.names[id] = name;
      } else if (action === "deny") {
        s.denied = [...without(s.denied), id];
        s.approved = without(s.approved);
      } else {
        s.approved = without(s.approved);
      }
    });
    return json({ ok: true });
  }

  if (p === "/api/whitelist") {
    if (!nodeOk) return bad("bad node id");
    if (!Array.isArray(body.commands) || !body.commands.every((c) => typeof c === "string" && COMMAND_RE.test(c))) {
      return bad("bad commands");
    }
    const cmds = [...new Set(body.commands as string[])];
    await ctx.mutate((s) => {
      s.whitelist[id] = cmds;
    });
    return json({ ok: true });
  }

  if (p === "/api/grant") {
    const user = typeof body.user === "string" ? body.user : "";
    if (!USER_ID_RE.test(user)) return bad("user must be a Discord user id (digits)");
    const nodes = body.nodes;
    if (nodes !== "*" && !(Array.isArray(nodes) && nodes.every((n) => typeof n === "string" && NODE_ID_RE.test(n)))) {
      return bad("bad nodes");
    }
    await ctx.mutate((s) => {
      s.grants[user] = { nodes: nodes === "*" ? "*" : [...new Set(nodes as string[])] };
    });
    return json({ ok: true });
  }

  if (p === "/api/grant/delete") {
    const user = typeof body.user === "string" ? body.user : "";
    if (!USER_ID_RE.test(user) || user === "*") return bad("bad user");
    await ctx.mutate((s) => {
      delete s.grants[user];
    });
    return json({ ok: true });
  }

  if (p === "/api/test") {
    if (!nodeOk) return bad("bad node id");
    const command = typeof body.command === "string" ? body.command : "";
    if (!COMMAND_RE.test(command)) return bad("bad command");
    const argStr = typeof body.args === "string" ? body.args.slice(0, 500) : "";
    const args = argStr.trim().split(/\s+/).filter(Boolean);
    try {
      const r = await ctx.runJob(command, args, {
        target: id,
        timeoutMs: 60_000,
        user: `${me.name} (dashboard)`,
        via: "dashboard",
      });
      return json({ ok: r.ok, output: r.output, ms: r.ms, node: r.node.name });
    } catch (e) {
      return json({ ok: false, output: (e as Error).message });
    }
  }

  return json({ error: "not found" }, 404);
}
