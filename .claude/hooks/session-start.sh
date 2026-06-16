#!/bin/bash
set -euo pipefail

# Only run in Claude Code on the web (remote) sessions.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Install JS dependencies (idempotent; container state is cached afterwards).
npm install

# Stage the web-ifc WASM binaries that the app serves at runtime.
node scripts/copy-wasm.mjs
