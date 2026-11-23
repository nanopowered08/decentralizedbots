import type { State } from "../shared/state.ts";

// What non-owners may run on a machine until the owner changes it in the dashboard.
export const DEFAULT_WHITELIST = ["ping", "sysinfo"];

export const whitelistFor = (s: State, nodeId: string): string[] => s.whitelist[nodeId] ?? DEFAULT_WHITELIST;

// "Everyone" defaults to all machines until the owner edits that row.
export const everyoneGrant = (s: State) => s.grants["*"] ?? { nodes: "*" as const };

const allows = (g: { nodes: "*" | string[] } | undefined, nodeId: string) =>
  !!g && (g.nodes === "*" || g.nodes.includes(nodeId));

export function grantAllows(s: State, userId: string, nodeId: string): boolean {
  return allows(s.grants[userId], nodeId) || allows(everyoneGrant(s), nodeId);
}

export const isApproved = (s: State, env: Set<string>, id: string) =>
  !s.denied.includes(id) && (s.approved.includes(id) || env.has(id));

// Owners can run anything a node provides. Everyone else needs BOTH:
// the machine whitelists the command, and they (or "Everyone") are granted that machine.
export function canUse(s: State, owners: Set<string>, userId: string, nodeId: string, cmd: string): boolean {
  if (owners.has(userId)) return true;
  return whitelistFor(s, nodeId).includes(cmd) && grantAllows(s, userId, nodeId);
}
