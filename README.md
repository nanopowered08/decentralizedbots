# nodebot

Semi-decentralized Discord bot. One **hub** (Replit) holds the Discord token; any number of **workers**
connect outbound over WebSocket at `/connect` and run jobs. Every worker must be approved from the hub.

## Hub (Replit)
1. Secrets: `DISCORD_TOKEN`, `REPO_URL`, optionally `GUILD_ID`.
2. Run command: `sh run-hub.sh` (clones/pulls the repo, then `deno task hub`).
3. Approve workers in the Replit **Shell**:
   `deno task admin approve <id>` (also `deny`, `revoke`, `list`). Run it inside `app/` if you use run-hub.sh.

## Worker (PC / Termux)
    HUB_URL=wss://your-repl.replit.app/connect NODE_NAME=my-phone deno task worker
It prints its node id and waits as `pending` until you approve it. Identity is a random token in `.worker-token`.

## Commands
| Command | Who | What |
|---|---|---|
| `/ping [node]` | anyone | round trip to a node |
| `/nodes` | anyone | online nodes with latency |
| `/sysinfo [node]` | anyone | OS, CPU, memory, load, uptime |
| `/run command [node]` | `OWNER_IDS` only | run an allowlisted program on a node |
| `/fetch url [node]` | `OWNER_IDS` only | HTTP GET from the node's network |

`node` is a node name or id; omit it for a random node.

Safety: `/run` and `/fetch` are disabled unless `OWNER_IDS` (comma separated Discord user ids) is set on the hub.
`/run` also needs the worker to opt in with `ALLOW_RUN=echo,df,uptime` (bare program names, no shell, 8s timeout).
`/fetch` refuses localhost/private/LAN addresses and doesn't follow redirects.

Add worker commands in `worker/commands.ts` (`handlers`) and the slash command in `hub/commands.ts`.

## Replit deployment note
Deployments can't reach npm at runtime, so discord.js is installed at build time into `node_modules/`.
In `.replit`:

    [deployment]
    deploymentTarget = "cloudrun"
    build = ["sh", "-c", "deno install"]
    run = ["sh", "-c", "PORT=8000 deno task hub"]
