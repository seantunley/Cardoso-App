#!/usr/bin/env bash
# Smoke test for Cardoso App Phase 1 Foundation Refactor
#
# Checks:
#   1. node --check passes for server.js and every backend file under src/
#   2. npm run build exits with code 0
#   3. The server starts and GET /api/health returns HTTP 200
#
# Usage:
#   ./scripts/smoke-test.sh
#
# Exit codes:
#   0 — all checks passed
#   1 — one or more checks failed

set -euo pipefail

cd "$(dirname "$0")/.."

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

# ---------- Check 1: Syntax checks ----------
echo "=== Syntax checks ==="

BACKEND_FILES=(
  server.js
  src/db/index.js
  src/db/schema.js
  src/db/statements.js
  src/db/migrations.js
  src/middleware/auth.js
  src/middleware/rateLimit.js
  src/fieldRegistry.js
  src/helpers.js
  src/services/encryption.js
  src/services/versionCheck.js
  src/services/autoFlag.js
  src/services/syncEngine.js
  src/services/hubEtl.js
  src/routes/auth.js
  src/routes/records.js
  src/routes/connections.js
  src/routes/hub.js
  src/routes/reporting.js
  src/routes/backup.js
  src/routes/system.js
  src/startup.js
  src/scheduler.js
)

for f in "${BACKEND_FILES[@]}"; do
  if node --check "$f" 2>/dev/null; then
    pass "node --check $f"
  else
    fail "node --check $f"
  fi
done

# ---------- Check 2: Vite build ----------
echo ""
echo "=== Vite build ==="
if npm run build --silent 2>/dev/null; then
  pass "npm run build"
else
  fail "npm run build"
fi

# ---------- Check 3: Server health check ----------
echo ""
echo "=== Health check ==="

# Pick a random high port to avoid conflicts
PORT=$((9000 + RANDOM % 1000))

# Ensure we have a session secret for startup
export SESSION_SECRET="${SESSION_SECRET:-smoke-test-secret-$(date +%s)}"
export PORT="$PORT"
export NODE_ENV="production"

# Start the server in the background
node server.js &
SERVER_PID=$!

# Cleanup on exit
cleanup() {
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Wait for the server to be ready (up to 10 seconds)
READY=false
for i in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    READY=true
    break
  fi
  sleep 0.5
done

if $READY; then
  # Verify response body
  BODY=$(curl -sf "http://127.0.0.1:$PORT/api/health")
  if echo "$BODY" | grep -q '"status":"ok"'; then
    pass "GET /api/health returns 200 with {\"status\":\"ok\"}"
  else
    fail "GET /api/health returned unexpected body: $BODY"
  fi
else
  fail "Server did not start within 10 seconds on port $PORT"
fi

# ---------- Summary ----------
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
