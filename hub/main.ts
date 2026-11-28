import { cleanCommands, idFromToken, type ToHub, type ToWorker } from "../shared/protocol.ts";
import { envApproved, loadState, readStateFile, saveState, STATE_DIR, type State } from "../shared/state.ts";
import { checkAccess, COMMAND_DEFS, type Deps, handleCommand, type JobOpts, type NodeInfo } from "./commands.ts";
import { authConfigFromEnv, handleAuth } from "./auth.ts";
import { type Activity, type ConnectedNode, handleDashboard } from "./dashboard.ts";
import { canUse, isApproved } from "./perms.ts";

const DISCORD_TOKEN = Deno.env.get("DISCORD_TOKEN");
let discordStatus = "starting"; // shown on the landing page so problems are visible without logs
const PORT = Number(Deno.env.get("PORT") ?? 8000);
const GUILD_ID = Deno.env.get("GUILD_ID"); // optional: instant slash-command registration
const MAX_PENDING = 20;
// Discord user ids of the bot owners: dashboard login, and they can run anything nodes provide.
const OWNER_IDS = new Set((Deno.env.get("OWNER_IDS") ?? "").split(",").map((x) => x.trim()).filter(Boolean));
const ENV_APPROVED = envApproved();
const AUTH = authConfigFromEnv();

interface Node extends ConnectedNode {
  ws: WebSocket;
}

// ---------- state (permissions live here; the dashboard edits it) ----------
let S: State = await loadState();
let selfWriteUntil = 0;
let chain: Promise<unknown> = Promise.resolve();

const approvedNow = (id: string) => isApproved(S, ENV_APPROVED, id);

function mutate(fn: (s: State) => void): Promise<void> {
  const p = chain.then(async () => {
    fn(S);
    selfWriteUntil = Date.now() + 600; // ignore the file-watch event our own write causes
    await saveState(S);
    applyApprovals();
  });
  chain = p.catch(() => {});
  return p;
}

const nodes = new Map<string, Node>();
const jobs = new Map<string, (r: { ok: boolean; output: string }) => void>();
const activity: Activity[] = [];
const seenUsers: Record<string, string> = {};
const send = (ws: WebSocket, m: ToWorker) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

function applyApprovals() {
  for (const n of nodes.values()) {
    if (S.denied.includes(n.id)) {
      send(n.ws, { t: "status", state: "denied" });
      n.ws.close();
      continue;
    }
    const ok = approvedNow(n.id);
    if (ok && !n.approved) {
      n.approved = true;
      send(n.ws, { t: "status", state: "approved" });
      console.log(`[node] approved ${n.name} (${n.id})`);
    } else if (!ok && n.approved) {
      n.approved = false;
      send(n.ws, { t: "status", state: "pending" });
      console.log(`[node] revoked ${n.name} (${n.id})`);
    }
  }
}

// ---------- /connect (workers) ----------
function handleSocket(ws: WebSocket) {
  let node: Node | undefined;

  ws.onmessage = async (e) => {
    let m: ToHub;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }

    if (m.t === "hello" && !node) {
      const id = await idFromToken(String(m.token));
      if (S.denied.includes(id)) {
        send(ws, { t: "status", state: "denied" });
        ws.close();
        return;
      }
      const approved = approvedNow(id);
      if (!approved && [...nodes.values()].filter((n) => !n.approved).length >= MAX_PENDING) {
        ws.close();
        return;
      }
      nodes.get(id)?.ws.close(); // same node reconnecting
      node = { id, name: String(m.name).slice(0, 32), ws, approved, commands: cleanCommands(m.commands) };
      nodes.set(id, node);
      if (approved) {
        send(ws, { t: "status", state: "approved" });
        console.log(`[node] ${node.name} (${id}) connected`);
        if (S.names[id] !== node.name) mutate((s) => void (s.names[id] = node!.name)).catch(() => {});
      } else {
        send(ws, { t: "status", state: "pending" });
        console.log(`[pending] ${node.name} wants to connect. Approve it in the dashboard, or: deno task admin approve ${id}`);
      }
    } else if (m.t === "result" && node?.approved) {
      jobs.get(m.id)?.({ ok: m.ok, output: String(m.output).slice(0, 1500) });
      jobs.delete(m.id);
    }
  };

  ws.onclose = () => {
    if (node && nodes.get(node.id)?.ws === ws) {
      nodes.delete(node.id);
      console.log(`[node] ${node.name} (${node.id}) left`);
    }
  };
}

// Pick up edits made with `deno task admin` (or by hand) to data/state.json
async function watchState() {
  await Deno.mkdir(STATE_DIR, { recursive: true });
  for await (const _ of Deno.watchFs(STATE_DIR)) {
    if (Date.now() < selfWriteUntil) continue;
    const f = await readStateFile();
    if (!f) continue;
    S = f;
    applyApprovals();
  }
}

// ---------- dispatch ----------
const toInfo = (n: Node): NodeInfo => ({ id: n.id, name: n.name, commands: n.commands?.map((c) => c.name) });

function runJob(cmd: string, args: string[] = [], opts: JobOpts = {}) {
  const { target, timeoutMs = 60_000, user = "?", via = "discord", quiet = false, allow } = opts;
  const log = (node: string, ok: boolean, ms: number) => {
    if (quiet) return;
    activity.unshift({ t: Date.now(), user, via, node, cmd, args: args.join(" ").slice(0, 120), ok, ms });
    activity.length = Math.min(activity.length, 100);
  };
  const fail = (msg: string) => {
    log("-", false, 0);
    return Promise.reject(new Error(msg));
  };

  let pool = [...nodes.values()].filter((n) => n.approved);
  if (!pool.length) return Promise.reject(new Error("No nodes online."));
  pool = pool.filter((n) => !n.commands || n.commands.some((c) => c.name === cmd));
  if (!pool.length) return fail(`No online node provides /${cmd}.`);
  if (allow) {
    pool = pool.filter((n) => allow(toInfo(n)));
    if (!pool.length) return fail(`You don't have access to /${cmd} on any online machine.`);
  }
  if (target) {
    const t = target.trim().toLowerCase();
    pool = pool.filter((n) => n.id === t || n.name.toLowerCase() === t);
    if (!pool.length) return fail(`No online node matches "${target}" that you can use.`);
  }
  const node = pool[Math.floor(Math.random() * pool.length)];
  const id = crypto.randomUUID();
  const start = performance.now();
  return new Promise<{ node: NodeInfo; ok: boolean; output: string; ms: number }>((resolve, reject) => {
    const timer = setTimeout(() => {
      jobs.delete(id);
      log(node.name, false, Math.round(performance.now() - start));
      reject(new Error(`${node.name} timed out.`));
    }, timeoutMs);
    jobs.set(id, (r) => {
      clearTimeout(timer);
      const ms = Math.round(performance.now() - start);
      log(node.name, r.ok, ms);
      resolve({ node: toInfo(node), ...r, ms });
    });
    send(node.ws, { t: "job", id, cmd, args });
  });
}

// ---------- HTTP ----------
const dashCtx = {
  cfg: AUTH,
  owners: OWNER_IDS,
  envApproved: ENV_APPROVED,
  state: () => S,
  mutate,
  connected: (): ConnectedNode[] => [...nodes.values()].map((n) => ({ id: n.id, name: n.name, approved: n.approved, commands: n.commands })),
  runJob,
  activity: () => activity,
  userNames: () => seenUsers,
};

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/connect" && req.headers.get("upgrade") === "websocket") {
    const { socket, response } = Deno.upgradeWebSocket(req);
    handleSocket(socket);
    return response;
  }
  if (AUTH) {
    const r = await handleAuth(req, url, AUTH, OWNER_IDS);
    if (r) return r;
  }
  const d = await handleDashboard(req, url, dashCtx);
  if (d) return d;
  if (url.pathname === "/health") return new Response("ok");
  const online = [...nodes.values()].filter((n) => n.approved).length;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>nodebot hub</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5}
code{background:#8882;padding:.1em .35em;border-radius:4px}</style></head><body>
<h1>nodebot hub 🐧💻</h1>
<p>This is the hub for a semi-decentralized Discord bot. The hub holds the Discord token; worker nodes
connect to <code>/connect</code> over WebSocket and run jobs for it. Every worker has to be approved by the owner.</p>
<p><b>Status:</b> hub is up · ${online} approved node${online === 1 ? "" : "s"} online</p>
<p><b>Discord:</b> ${discordStatus.replace(/</g, "&lt;")}</p>
<p>Slash commands: <code>/ping</code>, <code>/nodes</code>, <code>/sysinfo</code>, <code>/run</code>, <code>/fetch</code></p>
<p><a href="/dashboard">Owner dashboard</a></p>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
});
watchState().catch((e) => console.error("[watchState] failed:", e));

// ---------- Discord ----------
globalThis.addEventListener("unhandledrejection", (e) => {
  console.error("[unhandledrejection]", e.reason);
  e.preventDefault();
});

async function startDiscord() {
  if (!DISCORD_TOKEN) {
    discordStatus = "DISCORD_TOKEN is not set in this environment (add it to the deployment secrets)";
    console.error(`[discord] ${discordStatus}`);
    return;
  }
  discordStatus = "loading discord.js";
  // Dynamic import so Deno.serve (above) is already listening before discord.js loads.
  const { Client, GatewayIntentBits } = await import("discord.js");
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once("ready", async () => {
    discordStatus = `online as ${client.user?.tag}`;
    console.log(`Logged in as ${client.user?.tag}`);
    if (GUILD_ID) await client.guilds.cache.get(GUILD_ID)?.commands.set(COMMAND_DEFS);
    else await client.application?.commands.set(COMMAND_DEFS);
  });

  const deps: Deps = {
    runJob,
    onlineNodes: () => [...nodes.values()].filter((n) => n.approved).map(toInfo),
    canUse: (userId, nodeId, cmd) => canUse(S, OWNER_IDS, userId, nodeId, cmd),
  };

  client.on("interactionCreate", async (i) => {
    if (!i.isChatInputCommand()) return;
    const user = { id: i.user.id, name: i.user.username };
    seenUsers[user.id] = user.name;
    const denied = checkAccess(deps, i.commandName, user);
    if (denied) {
      await i.reply({ content: denied, flags: 64 }); // 64 = ephemeral
      return;
    }
    await i.deferReply();
    const text = await handleCommand(deps, i.commandName, (k) => i.options.getString(k), user);
    await i.editReply(text.slice(0, 1990));
  });

  discordStatus = "logging in";
  await client.login(DISCORD_TOKEN);
}

startDiscord().catch((e) => {
  discordStatus = `failed: ${(e as Error).message}`;
  console.error("[discord] failed:", e);
});
