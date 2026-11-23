export interface CommandInfo {
  name: string;
  description: string;
  usage?: string;
  risky?: boolean;
  detail?: string; // extra note shown in the dashboard (e.g. the worker's /run allowlist)
}

export type ToWorker =
  | { t: "status"; state: "pending" | "approved" | "denied" }
  | { t: "job"; id: string; cmd: string; args: string[] };

export type ToHub =
  | { t: "hello"; token: string; name: string; commands?: CommandInfo[] }
  | { t: "result"; id: string; ok: boolean; output: string };

// Node id = first 8 hex chars of sha256(token). The token never leaves the worker's disk
// except in the hello message; the hub only ever stores/prints the id.
export async function idFromToken(token: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 8);
}

// Workers are untrusted input: sanitize what they report before the hub stores or shows it.
export function cleanCommands(v: unknown): CommandInfo[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: CommandInfo[] = [];
  for (const c of v.slice(0, 32)) {
    if (!c || typeof c.name !== "string" || !/^[a-z0-9_-]{1,32}$/.test(c.name)) continue;
    out.push({
      name: c.name,
      description: String(c.description ?? "").slice(0, 200),
      usage: c.usage ? String(c.usage).slice(0, 100) : undefined,
      risky: c.risky === true,
      detail: c.detail ? String(c.detail).slice(0, 200) : undefined,
    });
  }
  return out;
}
