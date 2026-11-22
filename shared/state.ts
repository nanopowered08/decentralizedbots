export const STATE_DIR = "data";
export const STATE_PATH = `${STATE_DIR}/state.json`;

export interface State {
  approved: string[];
  denied: string[];
}

// Approvals stored in data/state.json (written by `deno task admin`).
export async function loadFileState(): Promise<State> {
  try {
    return JSON.parse(await Deno.readTextFile(STATE_PATH));
  } catch {
    return { approved: [], denied: [] };
  }
}

// Hub view: file state + ids from the APPROVED_NODES env var (comma separated).
// The env var survives redeploys/restarts, unlike files on Replit Autoscale.
export async function loadState(): Promise<State> {
  const st = await loadFileState();
  const extra = (Deno.env.get("APPROVED_NODES") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return { approved: [...new Set([...st.approved, ...extra])], denied: st.denied };
}

export async function saveState(s: State) {
  await Deno.mkdir(STATE_DIR, { recursive: true });
  await Deno.writeTextFile(STATE_PATH, JSON.stringify(s, null, 2));
}
