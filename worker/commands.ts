// Commands a worker can execute. Add new ones to `handlers` AND `commandInfo`.
import type { CommandInfo } from "../shared/protocol.ts";

export type Handler = (args: string[]) => string | Promise<string>;

// /run only works for programs listed here (comma separated). Empty = /run disabled on this node.
const ALLOW_RUN = (Deno.env.get("ALLOW_RUN") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const MAX_BODY = 64 * 1024;
const cap = (s: string, n = 1500) => (s.length > n ? s.slice(0, n) + "\n…(truncated)" : s);

// ---------- /sysinfo ----------
function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return `${d ? d + "d " : ""}${h}h ${m}m`;
}

function sysinfo(): string {
  const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
  const lines: string[] = [];
  const add = (label: string, f: () => string) => {
    try {
      lines.push(`${label}: ${f()}`);
    } catch {
      lines.push(`${label}: n/a`);
    }
  };
  add("host", () => Deno.hostname());
  add("os", () => `${Deno.build.os}/${Deno.build.arch} ${Deno.osRelease()}`);
  add("cpus", () => String(navigator.hardwareConcurrency));
  add("memory", () => {
    const m = Deno.systemMemoryInfo();
    return `${gb(m.total - m.available)} / ${gb(m.total)} GB used`;
  });
  add("load", () => Deno.loadavg().map((x) => x.toFixed(2)).join(" "));
  add("uptime", () => fmtUptime(Deno.osUptime()));
  add("deno", () => Deno.version.deno);
  return lines.join("\n");
}

// ---------- /run ----------
async function run(args: string[]): Promise<string> {
  const [prog, ...rest] = args;
  if (!prog) throw new Error("usage: run <program> [args]");
  if (/[\\/]/.test(prog)) throw new Error("use a bare program name, not a path");
  if (!ALLOW_RUN.length) throw new Error("this node has no ALLOW_RUN list, so /run is disabled here");
  if (!ALLOW_RUN.includes(prog)) throw new Error(`'${prog}' is not in this node's ALLOW_RUN list`);
  // No shell: arguments are passed straight to the program, so no pipes, && or $(...) tricks.
  const out = await new Deno.Command(prog, {
    args: rest,
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(8000),
  }).output();
  const dec = new TextDecoder();
  const text = (dec.decode(out.stdout) + dec.decode(out.stderr)).trim();
  return cap(`${text || "(no output)"}\n[exit ${out.code}]`);
}

// ---------- /fetch ----------
function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) {
    const l = ip.toLowerCase();
    return l === "::1" || l === "::" || /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith("::ffff:");
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

// Refuse anything that points at the worker's own machine or LAN.
export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("not a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http(s) URLs are allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || /\.(localhost|local|internal|lan)$/.test(host)) throw new Error("local hostnames are blocked");
  const isIp = host.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(host);
  const ips: string[] = isIp ? [host] : [];
  if (!isIp) {
    for (const type of ["A", "AAAA"] as const) {
      try {
        ips.push(...(await Deno.resolveDns(host, type)));
      } catch { /* no records of this type */ }
    }
    if (!ips.length) throw new Error(`could not resolve ${host}`);
  }
  if (ips.some(isPrivateIp)) throw new Error("that address is private/local, blocked");
  return u;
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  while (n < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.length;
  }
  await reader.cancel().catch(() => {});
  const all = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  return new TextDecoder().decode(all.slice(0, max));
}

async function fetchUrl([raw]: string[]): Promise<string> {
  if (!raw) throw new Error("usage: fetch <url>");
  const u = await assertPublicUrl(raw);
  const t0 = performance.now();
  // Redirects are reported, not followed, so a public URL can't bounce us onto the LAN.
  const res = await fetch(u, {
    redirect: "manual",
    signal: AbortSignal.timeout(8000),
    headers: { "user-agent": "nodebot-worker" },
  });
  const ms = Math.round(performance.now() - t0);
  const type = res.headers.get("content-type") ?? "unknown";
  const loc = res.headers.get("location");
  const textual = /^(text\/|application\/(json|xml|javascript))/.test(type);
  const body = textual ? await readCapped(res, MAX_BODY) : (await res.body?.cancel(), "");
  return cap(
    `${res.status} ${res.statusText} · ${type} · ${ms}ms` + (loc ? `\nredirect -> ${loc}` : "") +
      (body ? `\n\n${body.trim()}` : ""),
    1000,
  );
}

export const handlers: Record<string, Handler> = {
  ping: () => `pong from ${Deno.hostname()} (${Deno.build.os}/${Deno.build.arch})`,
  sysinfo,
  run,
  fetch: fetchUrl,
};

// What this worker tells the hub (and the dashboard) about its commands.
export const commandInfo: CommandInfo[] = [
  { name: "ping", description: "Round-trip check; returns this node's hostname and OS." },
  { name: "sysinfo", description: "OS, CPU count, memory, load and uptime." },
  {
    name: "run",
    description: "Run an allowlisted program on this node. No shell, 8 second timeout.",
    usage: "<program> [args]",
    risky: true,
    detail: `allowed programs: ${ALLOW_RUN.join(", ") || "none (disabled on this node)"}`,
  },
  {
    name: "fetch",
    description: "HTTP GET from this node's network. Local/private addresses are blocked.",
    usage: "<url>",
    risky: true,
  },
];
