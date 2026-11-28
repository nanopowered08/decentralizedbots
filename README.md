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
| `/run command [node]` | owners, or users you grant | run an allowlisted program on a node |
| `/fetch url [node]` | owners, or users you grant | HTTP GET from the node's network |

`node` is a node name or id; omit it for a random node.

Safety: owners (`OWNER_IDS`, comma separated Discord user ids) can run anything a node provides. Everyone else can only run
commands the owner whitelisted for that machine in the dashboard (default: `ping`, `sysinfo`), and only on machines they were granted.
`/run` also needs the worker to opt in with `ALLOW_RUN=echo,df,uptime` (bare program names, no shell, 60s timeout).
`/fetch` refuses localhost/private/LAN addresses and doesn't follow redirects.

Add worker commands in `worker/commands.ts` (`handlers`) and the slash command in `hub/commands.ts`.

## Replit deployment note
Deployments can't reach npm at runtime, so discord.js is installed at build time into `node_modules/`.
In `.replit`:

    [deployment]
    deploymentTarget = "cloudrun"
    build = ["sh", "-c", "deno install"]
    run = ["sh", "-c", "PORT=8000 deno task hub"]

## Owner dashboard (`/dashboard`)
Log in with Discord (only ids in `OWNER_IDS`). From the browser you can:
- approve / deny / revoke machines (no shell needed), see the commands each one provides, and **test them live**
- whitelist which commands non-owners may run on each machine
- grant specific Discord users access to specific machines (or restrict "Everyone")
- see recent activity (Discord and dashboard runs)

Setup:
1. Discord Developer Portal > your app > OAuth2: copy the **Client ID** and **Client Secret**, and add the redirect
   `https://<your-app>.replit.app/auth/callback`.
2. Hub secrets: `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `PUBLIC_URL` (e.g. `https://<your-app>.replit.app`),
   `SESSION_SECRET` (any long random string), `OWNER_IDS`.
3. Optional but recommended on Replit Autoscale: dashboard changes are stored in `data/state.json`, which is wiped on restart.
   If `REPLIT_DB_URL` is available (Replit Database), they are also saved there and restored on boot.
   `APPROVED_NODES` still works as a permanent approval list that the dashboard cannot revoke.
