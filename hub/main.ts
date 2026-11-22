import { idFromToken, type ToHub, type ToWorker } from "../shared/protocol.ts";
import { loadState, STATE_DIR } from "../shared/state.ts";

const DISCORD_TOKEN = Deno.env.get("DISCORD_TOKEN");
if (!DISCORD_TOKEN) throw new Error("Set DISCORD_TOKEN");
const PORT = Number(Deno.env.get("PORT") ?? 8000);
const GUILD_ID = Deno.env.get("GUILD_ID"); // optional: instant slash-command registration
const MAX_PENDING = 20;

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
  return new Response("hub ok");
});
watchState();

// ---------- dispatch ----------
function runJob(cmd: string, args: string[] = []) {
  const ready = [...nodes.values()].filter((n) => n.approved);
  if (!ready.length) return Promise.reject(new Error("No nodes online."));
  const node = ready[Math.floor(Math.random() * ready.length)];
  const id = crypto.randomUUID();
  const start = performance.now();
  return new Promise<{ node: Node; ok: boolean; output: string; ms: number }>((resolve, reject) => {
    const timer = setTimeout(() => {
      jobs.delete(id);
      reject(new Error(`${node.name} timed out.`));
    }, 10_000);
    jobs.set(id, (r) => {
      clearTimeout(timer);
      resolve({ node, ...r, ms: Math.round(performance.now() - start) });
    });
    send(node.ws, { t: "job", id, cmd, args });
  });
}

// ---------- Discord ----------
// Dynamic import so Deno.serve (above) is already listening before discord.js downloads.
const { Client, GatewayIntentBits } = await import("npm:discord.js@14");
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const commands = [
  { name: "ping", description: "Ping a random worker node" },
  { name: "nodes", description: "List approved nodes that are online" },
];

client.once("ready", async () => {
  console.log(`Logged in as ${client.user?.tag}`);
  if (GUILD_ID) await client.guilds.cache.get(GUILD_ID)?.commands.set(commands);
  else await client.application?.commands.set(commands);
});

client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;
  if (i.commandName === "nodes") {
    const list = [...nodes.values()].filter((n) => n.approved).map((n) => `• ${n.name} (\`${n.id}\`)`);
    await i.reply(list.length ? list.join("\n") : "No nodes online.");
  } else if (i.commandName === "ping") {
    await i.deferReply();
    try {
      const r = await runJob("ping");
      await i.editReply(`🏓 **${r.node.name}** (\`${r.node.id}\`): ${r.output} · ${r.ms}ms round trip`);
    } catch (e) {
      await i.editReply(`⚠️ ${(e as Error).message}`);
    }
  }
});

client.login(DISCORD_TOKEN);
