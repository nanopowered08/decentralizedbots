// Slash command definitions and logic. Kept free of discord.js so it can be tested on its own.
const STRING = 3; // Discord option type

const nodeOpt = { type: STRING, name: "node", description: "Node name or id (default: random)", required: false };

export const COMMAND_DEFS = [
  { name: "ping", description: "Ping a worker node", options: [nodeOpt] },
  { name: "nodes", description: "List the online nodes you can use, with latency" },
  { name: "sysinfo", description: "OS, CPU, memory and uptime of a node", options: [nodeOpt] },
  {
    name: "run",
    description: "Run an allowlisted program on a node",
    options: [{ type: STRING, name: "command", description: "program and arguments, e.g. df -h", required: true }, nodeOpt],
  },
  {
    name: "fetch",
    description: "Fetch a URL from a node's network",
    options: [{ type: STRING, name: "url", description: "http(s) URL", required: true }, nodeOpt],
  },
];

export interface NodeInfo {
  id: string;
  name: string;
  commands?: string[]; // names the node provides, if it reported them
}

export interface JobOpts {
  target?: string | null;
  timeoutMs?: number;
  user?: string;
  via?: "discord" | "dashboard";
  quiet?: boolean; // don't add to the activity log
  allow?: (n: NodeInfo) => boolean;
}

export interface Deps {
  runJob(
    cmd: string,
    args: string[],
    opts?: JobOpts,
  ): Promise<{ node: NodeInfo; ok: boolean; output: string; ms: number }>;
  onlineNodes(): NodeInfo[];
  canUse(userId: string, nodeId: string, cmd: string): boolean;
}

export interface Caller {
  id: string;
  name: string;
}

// Returns a refusal message (to send privately), or null if the caller may proceed.
export function checkAccess(d: Deps, command: string, user: Caller): string | null {
  if (command === "nodes") return null;
  const online = d.onlineNodes();
  if (!online.length) return null; // the normal path says "No nodes online."
  if (!online.some((n) => d.canUse(user.id, n.id, command))) {
    return `You don't have access to /${command} on any online machine.`;
  }
  return null;
}

export const fence = (s: string) => "```\n" + s.replaceAll("```", "`\u200b``").slice(0, 1700) + "\n```";
const tag = (n: NodeInfo) => `**${n.name}** (\`${n.id}\`)`;

// Never throws; always returns text to send back.
export async function handleCommand(
  d: Deps,
  command: string,
  opt: (name: string) => string | null,
  user: Caller,
): Promise<string> {
  try {
    const target = opt("node");
    const base = { user: user.name, via: "discord" as const, allow: (n: NodeInfo) => d.canUse(user.id, n.id, command) };
    const done = (icon: string, r: { node: NodeInfo; ok: boolean; output: string }, body: string) =>
      r.ok ? `${icon} ${tag(r.node)}\n${fence(body)}` : `⚠️ ${tag(r.node)}: ${r.output}`;

    if (command === "nodes") {
      const visible = d.onlineNodes().filter((n) => (n.commands ?? ["ping"]).some((c) => d.canUse(user.id, n.id, c)));
      if (!visible.length) return "No nodes available to you.";
      const rows = await Promise.all(visible.map(async (n) => {
        try {
          const r = await d.runJob("ping", [], { target: n.id, timeoutMs: 3000, quiet: true });
          return { n, ms: r.ms as number | null };
        } catch {
          return { n, ms: null };
        }
      }));
      rows.sort((a, b) => (a.ms ?? Infinity) - (b.ms ?? Infinity));
      return rows.map((r) => `• ${r.n.name} (\`${r.n.id}\`): ${r.ms === null ? "no response" : r.ms + " ms"}`).join("\n");
    }
    if (command === "ping") {
      const r = await d.runJob("ping", [], { ...base, target });
      return r.ok ? `🏓 ${tag(r.node)}: ${r.output} · ${r.ms} ms round trip` : `⚠️ ${tag(r.node)}: ${r.output}`;
    }
    if (command === "sysinfo") {
      const r = await d.runJob("sysinfo", [], { ...base, target });
      return done("🖥️", r, r.output);
    }
    if (command === "run") {
      const args = (opt("command") ?? "").trim().split(/\s+/).filter(Boolean);
      const r = await d.runJob("run", args, { ...base, target });
      return done("💻", r, r.output);
    }
    if (command === "fetch") {
      const r = await d.runJob("fetch", [(opt("url") ?? "").trim()], { ...base, target });
      return done("🌐", r, r.output);
    }
    return `Unknown command: ${command}`;
  } catch (e) {
    return `⚠️ ${(e as Error).message}`;
  }
}
