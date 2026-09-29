#!/bin/sh
# Codex currently executes command hooks. This adapter forwards the exact hook
# JSON to the warm backend and prints its body unchanged. A 204 response has no
# body, which Codex interprets as "continue". Network failures fail open.
base_url="${CONTEXT_BRAKE_API_URL:-http://127.0.0.1:7788}"

curl --silent --show-error \
  --request POST \
  --output - \
  --max-time "${CONTEXT_BRAKE_HOOK_TIMEOUT_SECONDS:-0.3}" \
  --header 'content-type: application/json' \
  --data-binary @- \
  "${base_url%/}/v1/hooks/codex" \
  2>/dev/null || true
