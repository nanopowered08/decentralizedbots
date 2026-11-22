import { idFromToken, type ToHub, type ToWorker } from "../shared/protocol.ts";
import { loadState, STATE_DIR } from "../shared/state.ts";
import { checkAccess, COMMAND_DEFS, handleCommand } from "./commands.ts";

const DISCORD_TOKEN = Deno.env.get("DISCORD_TOKEN");
let discordStatus = "starting"; // shown on the landing page so problems are visible without logs
const PORT = Number(Deno.env.get("PORT") ?? 8000);
const GUILD_ID = Deno.env.get("GUILD_ID"); // optional: instant slash-command registration
const MAX_PENDING = 20;
// Discord user ids allowed to use /run and /fetch (comma separated). Empty = those commands are disabled.
const OWNER_IDS = new Set((Deno.env.get("OWNER_IDS") ?? "").split(",").map((x) => x.trim()).filter(Boolean));

interface Node {
  id: string;
  name: string;
  ws: WebSocket;
  approved: boolean;
}

const nodes = new Map<string, Node>();
const jobs = new Map<string, (r: { ok: boolean; output: string }) => void>();
const send = (ws: WebSocket, m: ToWorker) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

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
      const st = await loadState();
      if (st.denied.includes(id)) {
        send(ws, { t: "status", state: "denied" });
        ws.close();
        return;
      }
      const approved = st.approved.includes(id);
      if (!approved && [...nodes.values()].filter((n) => !n.approved).length >= MAX_PENDING) {
        ws.close();
        return;
      }
      nodes.get(id)?.ws.close(); // same node reconnecting
      node = { id, name: String(m.name).slice(0, 32), ws, approved };
      nodes.set(id, node);
      if (approved) {
        send(ws, { t: "status", state: "approved" });
        console.log(`[node] ${node.name} (${id}) connected`);
      } else {
        send(ws, { t: "status", state: "pending" });
        console.log(`[pending] ${node.name} wants to connect. Approve with: deno task admin approve ${id}`);
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

// Re-check approvals whenever `deno task admin` edits data/state.json
async function watchState() {
  await Deno.mkdir(STATE_DIR, { recursive: true });
  for await (const _ of Deno.watchFs(STATE_DIR)) {
    const st = await loadState();
    for (const n of nodes.values()) {
      if (st.denied.includes(n.id)) {
        send(n.ws, { t: "status", state: "denied" });
        n.ws.close();
      } else if (st.approved.includes(n.id) && !n.approved) {
        n.approved = true;
        send(n.ws, { t: "status", state: "approved" });
        console.log(`[node] approved ${n.name} (${n.id})`);
      } else if (!st.approved.includes(n.id) && n.approved) {
        n.approved = false;
        send(n.ws, { t: "status", state: "pending" });
        console.log(`[node] revoked ${n.name} (${n.id})`);
      }
    }
  }
}

Deno.serve({ port: PORT }, (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/connect" && req.headers.get("upgrade") === "websocket") {
    const { socket, response } = Deno.upgradeWebSocket(req);
    handleSocket(socket);
    return response;
  }
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
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
});
watchState().catch((e) => console.error("[watchState] failed:", e));

// ---------- dispatch ----------
function runJob(cmd: string, args: string[] = [], target?: string | null, timeoutMs = 10_000) {
  let pool = [...nodes.values()].filter((n) => n.approved);
  if (!pool.length) return Promise.reject(new Error("No nodes online."));
  if (target) {
    const t = target.trim().toLowerCase();
    pool = pool.filter((n) => n.id === t || n.name.toLowerCase() === t);
    if (!pool.length) return Promise.reject(new Error(`No online node matches "${target}".`));
  }
  const node = pool[Math.floor(Math.random() * pool.length)];
  const id = crypto.randomUUID();
  const start = performance.now();
  return new Promise<{ node: Node; ok: boolean; output: string; ms: number }>((resolve, reject) => {
    const timer = setTimeout(() => {
      jobs.delete(id);
      reject(new Error(`${node.name} timed out.`));
    }, timeoutMs);
    jobs.set(id, (r) => {
      clearTimeout(timer);
      resolve({ node, ...r, ms: Math.round(performance.now() - start) });
    });
    send(node.ws, { t: "job", id, cmd, args });
  });
}

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
  // Loaded from ./node_modules (installed by `npm install`), so no runtime downloads are needed.
  const { Client, GatewayIntentBits } = await import("discord.js");
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.once("ready", async () => {
    discordStatus = `online as ${client.user?.tag}`;
    console.log(`Logged in as ${client.user?.tag}`);
    if (GUILD_ID) await client.guilds.cache.get(GUILD_ID)?.commands.set(COMMAND_DEFS);
    else await client.application?.commands.set(COMMAND_DEFS);
  });

  const deps = {
    runJob,
    onlineNodes: () => [...nodes.values()].filter((n) => n.approved),
    ownerIds: OWNER_IDS,
  };

  client.on("interactionCreate", async (i) => {
    if (!i.isChatInputCommand()) return;
    const denied = checkAccess(deps, i.commandName, i.user.id);
    if (denied) {
      await i.reply({ content: denied, flags: 64 }); // 64 = ephemeral
      return;
    }
    await i.deferReply();
    const text = await handleCommand(deps, i.commandName, (k) => i.options.getString(k));
    await i.editReply(text.slice(0, 1990));
  });

  discordStatus = "logging in";
  await client.login(DISCORD_TOKEN);
}

startDiscord().catch((e) => {
  discordStatus = `failed: ${(e as Error).message}`;
  console.error("[discord] failed:", e);
});
