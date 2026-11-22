// Run in the Replit shell:  deno task admin approve <id>
import { loadState, saveState } from "./shared/state.ts";

const [action, id] = Deno.args;
const st = await loadState();

if (action === "list" || !action) {
  console.log("approved:", st.approved.join(", ") || "(none)");
  console.log("denied:  ", st.denied.join(", ") || "(none)");
  Deno.exit(0);
}
if (!id) {
  console.error("usage: deno task admin <approve|deny|revoke|list> <id>");
  Deno.exit(1);
}

const without = (a: string[]) => a.filter((x) => x !== id);
if (action === "approve") {
  st.approved = [...without(st.approved), id];
  st.denied = without(st.denied);
} else if (action === "deny") {
  st.denied = [...without(st.denied), id];
  st.approved = without(st.approved);
} else if (action === "revoke") {
  st.approved = without(st.approved);
} else {
  console.error("unknown action:", action);
  Deno.exit(1);
}
await saveState(st);
console.log(`${action} ${id}: ok`);
