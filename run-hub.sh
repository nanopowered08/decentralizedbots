#!/bin/sh
# Replit entrypoint: clone (or update) the repo, then run the hub.
# Set REPO_URL as a Replit secret, e.g. https://github.com/nanopowered08/nodebot.git
set -e
: "${REPO_URL:?set REPO_URL}"
if [ -d app/.git ]; then git -C app pull --ff-only; else git clone "$REPO_URL" app; fi
cd app
exec deno task hub
