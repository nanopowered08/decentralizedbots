import { idFromToken, type ToHub, type ToWorker } from "../shared/protocol.ts";
import { commandInfo, handlers } from "./commands.ts";

const HUB_URL = Deno.env.get("HUB_URL"); // e.g. wss://your-repl.replit.app/connect
if (!HUB_URL) throw new Error("Set HUB_URL");
const NAME = Deno.env.get("NODE_NAME") ?? Deno.hostname();
const TOKEN_FILE = ".worker-token";

async function getToken(): Promise<string> {
  try {
    return (await Deno.readTextFile(TOKEN_FILE)).trim();
  } catch {
    const t = crypto.randomUUID() + crypto.randomUUID();
    await Deno.writeTextFile(TOKEN_FILE, t);
    return t;
  }
}

// Commands live in worker/commands.ts.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const token = await getToken();
console.log(`node id: ${await idFromToken(token)} (name: ${NAME})`);

let delay = 1000;
while (true) {
  await new Promise<void>((done) => {
    const ws = new WebSocket(HUB_URL);
    const send = (m: ToHub) => ws.send(JSON.stringify(m));
    ws.onopen = () => {
      delay = 1000;
      send({ t: "hello", token, name: NAME, commands: commandInfo });
    };
    ws.onmessage = async (e) => {
      const m = JSON.parse(e.data) as ToWorker;
      if (m.t === "status") {
        console.log(`hub says: ${m.state}`);
        if (m.state === "denied") Deno.exit(1);
      } else if (m.t === "job") {
        try {
          const h = handlers[m.cmd];
          if (!h) throw new Error(`unknown command: ${m.cmd}`);
          send({ t: "result", id: m.id, ok: true, output: await h(m.args) });
        } catch (err) {
          send({ t: "result", id: m.id, ok: false, output: (err as Error).message });
        }
      }
    };
    ws.onclose = () => done();
    ws.onerror = () => {};
  });
  console.log(`disconnected, retrying in ${delay / 1000}s`);
  await sleep(delay);
  delay = Math.min(delay * 2, 30_000);
}
