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
`/ping` runs on a random approved node. `/nodes` lists them. Add worker commands in `worker/main.ts` (`handlers`).
