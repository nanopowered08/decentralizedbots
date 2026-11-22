export type ToWorker =
  | { t: "status"; state: "pending" | "approved" | "denied" }
  | { t: "job"; id: string; cmd: string; args: string[] };

export type ToHub =
  | { t: "hello"; token: string; name: string }
  | { t: "result"; id: string; ok: boolean; output: string };

// Node id = first 8 hex chars of sha256(token). The token never leaves the worker's disk
// except in the hello message; the hub only ever stores/prints the id.
export async function idFromToken(token: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 8);
}
