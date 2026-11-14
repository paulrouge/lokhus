#!/usr/bin/env bash
set -euo pipefail

node --disable-warning=ExperimentalWarning --env-file-if-exists=.env --watch packages/server/src/index.ts &
API_PID=$!
trap 'kill $API_PID 2>/dev/null' EXIT

npm run dev -w @msa/web
