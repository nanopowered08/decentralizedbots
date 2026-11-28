export const STATE_DIR = "data";
export const STATE_PATH = `${STATE_DIR}/state.json`;
const DB_KEY = "nodebot_state";

export interface Grant {
  nodes: "*" | string[]; // machines this user (or "*" = everyone) may use
}

export interface State {
  approved: string[];
  denied: string[];
  whitelist: Record<string, string[]>; // nodeId -> commands non-owners may run there
  grants: Record<string, Grant>; // discord user id, or "*" for everyone
  names: Record<string, string>; // last seen name of approved nodes
}

export const NODE_ID_RE = /^[0-9a-f]{32}$/;
export const USER_ID_RE = /^(\*|\d{5,25})$/;

export const emptyState = (): State => ({ approved: [], denied: [], whitelist: {}, grants: {}, names: {} });

export function normalizeState(raw: unknown): State {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const obj = (v: unknown) =>
    (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
  const s = emptyState();
  s.approved = strs(r.approved);
  s.denied = strs(r.denied);
  for (const [k, v] of Object.entries(obj(r.whitelist))) if (NODE_ID_RE.test(k)) s.whitelist[k] = strs(v);
  for (const [k, v] of Object.entries(obj(r.grants))) {
    if (!USER_ID_RE.test(k)) continue;
    const n = (v as { nodes?: unknown })?.nodes;
    s.grants[k] = { nodes: n === "*" ? "*" : strs(n).filter((x) => NODE_ID_RE.test(x)) };
  }
  for (const [k, v] of Object.entries(obj(r.names))) if (NODE_ID_RE.test(k) && typeof v === "string") s.names[k] = v.slice(0, 32);
  return s;
}

// null = file exists but is unreadable right now (e.g. mid-write); callers should keep what they have.
export async function readStateFile(): Promise<State | null> {
  try {
    return normalizeState(JSON.parse(await Deno.readTextFile(STATE_PATH)));
  } catch (e) {
    return e instanceof Deno.errors.NotFound ? emptyState() : null;
  }
}

export async function loadFileState(): Promise<State> {
  return (await readStateFile()) ?? emptyState();
}

// ---- optional Replit Database backend (survives Autoscale restarts) ----
async function dbLoad(): Promise<State | null> {
  const url = Deno.env.get("REPLIT_DB_URL");
  if (!url) return null;
  try {
    const r = await fetch(`${url}/${DB_KEY}`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) {
      await r.body?.cancel();
      return null;
    }
    return normalizeState(JSON.parse(await r.text()));
  } catch {
    return null;
  }
}

async function dbSave(s: State) {
  const url = Deno.env.get("REPLIT_DB_URL");
  if (!url) return;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ [DB_KEY]: JSON.stringify(s) }),
      signal: AbortSignal.timeout(5000),
    });
    await r.body?.cancel();
    if (!r.ok) console.error(`[state] Replit DB save failed: HTTP ${r.status}`);
  } catch (e) {
    console.error("[state] Replit DB save failed:", (e as Error).message);
  }
}

export async function saveState(s: State) {
  await Deno.mkdir(STATE_DIR, { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(s, null, 2));
  await Deno.rename(tmp, STATE_PATH); // atomic, so readers never see half a file
  await dbSave(s);
}

// Hub boot: Replit DB if configured and populated, otherwise the local file.
export async function loadState(): Promise<State> {
  const fromDb = await dbLoad();
  if (fromDb) {
    console.log("[state] loaded from Replit DB");
    return fromDb;
  }
  return await loadFileState();
}

// Ids approved through the APPROVED_NODES env var (kept separate so dashboard edits never rewrite it).
export function envApproved(): Set<string> {
  return new Set((Deno.env.get("APPROVED_NODES") ?? "").split(",").map((x) => x.trim()).filter(Boolean));
}
