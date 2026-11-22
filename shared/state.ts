export const STATE_DIR = "data";
export const STATE_PATH = `${STATE_DIR}/state.json`;

export interface State {
  approved: string[];
  denied: string[];
}

export async function loadState(): Promise<State> {
  try {
    return JSON.parse(await Deno.readTextFile(STATE_PATH));
  } catch {
    return { approved: [], denied: [] };
  }
}

export async function saveState(s: State) {
  await Deno.mkdir(STATE_DIR, { recursive: true });
  await Deno.writeTextFile(STATE_PATH, JSON.stringify(s, null, 2));
}
