// Slash command definitions and logic. Kept free of discord.js so it can be tested on its own.
const STRING = 3; // Discord option type

const nodeOpt = { type: STRING, name: "node", description: "Node name or id (default: random)", required: false };

export const COMMAND_DEFS = [
  { name: "ping", description: "Ping a worker node", options: [nodeOpt] },
  { name: "nodes", description: "List online nodes with latency" },
  { name: "sysinfo", description: "OS, CPU, memory and uptime of a node", options: [nodeOpt] },
  {
    name: "run",
    description: "Run an allowlisted program on a node (owner only)",
    options: [{ type: STRING, name: "command", description: "program and arguments, e.g. df -h", required: true }, nodeOpt],
  },
  {
    name: "fetch",
    description: "Fetch a URL from a node's network (owner only)",
    options: [{ type: STRING, name: "url", description: "http(s) URL", required: true }, nodeOpt],
  },
];

export interface NodeInfo {
  id: string;
  name: string;
}

export interface Deps {
  runJob(
    cmd: string,
    args: string[],
    target?: string | null,
    timeoutMs?: number,
  ): Promise<{ node: NodeInfo; ok: boolean; output: string; ms: number }>;
  onlineNodes(): NodeInfo[];
  ownerIds: Set<string>;
}

const RESTRICTED = new Set(["run", "fetch"]);

// Returns a refusal message, or null if the user may run the command. Call this before deferring.
export function checkAccess(d: Deps, command: string, userId: string): string | null {
  if (!RESTRICTED.has(command)) return null;
  if (d.ownerIds.size === 0) return `/${command} is disabled: set OWNER_IDS on the hub.`;
  if (!d.ownerIds.has(userId)) return `Only the bot owner can use /${command}.`;
  return null;
}

export const fence = (s: string) => "```\n" + s.replaceAll("```", "`\u200b``").slice(0, 1700) + "\n```";
const tag = (n: NodeInfo) => `**${n.name}** (\`${n.id}\`)`;

// Never throws; always returns text to send back.
export async function handleCommand(
  d: Deps,
  command: string,
  opt: (name: string) => string | null,
): Promise<string> {
  try {
    const target = opt("node");
    if (command === "nodes") {
      const nodes = d.onlineNodes();
      if (!nodes.length) return "No nodes online.";
      const rows = await Promise.all(nodes.map(async (n) => {
        try {
          const r = await d.runJob("ping", [], n.id, 3000);
          return { n, ms: r.ms as number | null };
        } catch {
          return { n, ms: null };
        }
      }));
      rows.sort((a, b) => (a.ms ?? Infinity) - (b.ms ?? Infinity));
      return rows.map((r) => `• ${r.n.name} (\`${r.n.id}\`): ${r.ms === null ? "no response" : r.ms + " ms"}`).join("\n");
    }
    if (command === "ping") {
      const r = await d.runJob("ping", [], target);
      return r.ok ? `🏓 ${tag(r.node)}: ${r.output} · ${r.ms} ms round trip` : `⚠️ ${tag(r.node)}: ${r.output}`;
    }
    if (command === "sysinfo") {
      const r = await d.runJob("sysinfo", [], target);
      return r.ok ? `🖥️ ${tag(r.node)}\n${fence(r.output)}` : `⚠️ ${tag(r.node)}: ${r.output}`;
    }
    if (command === "run") {
      const args = (opt("command") ?? "").trim().split(/\s+/).filter(Boolean);
      const r = await d.runJob("run", args, target);
      return r.ok ? `💻 ${tag(r.node)}\n${fence(r.output)}` : `⚠️ ${tag(r.node)}: ${r.output}`;
    }
    if (command === "fetch") {
      const r = await d.runJob("fetch", [(opt("url") ?? "").trim()], target);
      return r.ok ? `🌐 ${tag(r.node)}\n${fence(r.output)}` : `⚠️ ${tag(r.node)}: ${r.output}`;
    }
    return `Unknown command: ${command}`;
  } catch (e) {
    return `⚠️ ${(e as Error).message}`;
  }
}
