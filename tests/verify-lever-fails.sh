#!/usr/bin/env bash
set -euo pipefail

echo "================================================="
echo "Running archive-settings-smoke verification matrix"
echo "================================================="

# Test 1: Baseline normal smoke run -> expect exit 0
echo "[1/4] Testing normal smoke execution (expect exit 0)..."
OUTPUT=$(node scripts/verify-archive-smoke.mjs --json)
EXIT_CODE=$(echo "$OUTPUT" | jq -r '.exit_code')
if [ "$EXIT_CODE" -ne 0 ]; then
  echo "FAIL: Expected exit 0, got $EXIT_CODE"
  exit 1
fi
echo "  -> OK: Normal smoke passed with exit 0."

# Test 2: Injected stage 1 fault (white screen/pageerror) -> expect exit 2
echo "[2/4] Testing stage 1 fault injection (expect exit 2)..."
set +e
OUTPUT=$(node scripts/verify-archive-smoke.mjs --inject-fail-stage-1 --json 2>/dev/null)
EXIT_CODE=$?
set -e
if [ "$EXIT_CODE" -ne 2 ]; then
  echo "FAIL: Expected exit 2, got $EXIT_CODE"
  exit 1
fi
STAGE=$(echo "$OUTPUT" | jq -r '.failed_stage')
if [ "$STAGE" != "page_initialization" ]; then
  echo "FAIL: Expected failed_stage page_initialization, got $STAGE"
  exit 1
fi
echo "  -> OK: Stage 1 intercepted correctly with exit 2."

# Test 3: Injected stage 2 fault (SW handshake failure) -> expect exit 3
echo "[3/4] Testing stage 2 fault injection (expect exit 3)..."
set +e
OUTPUT=$(node scripts/verify-archive-smoke.mjs --inject-fail-stage-2 --json 2>/dev/null)
EXIT_CODE=$?
set -e
if [ "$EXIT_CODE" -ne 3 ]; then
  echo "FAIL: Expected exit 3, got $EXIT_CODE"
  exit 1
fi
STAGE=$(echo "$OUTPUT" | jq -r '.failed_stage')
if [ "$STAGE" != "sw_handshake" ]; then
  echo "FAIL: Expected failed_stage sw_handshake, got $STAGE"
  exit 1
fi
echo "  -> OK: Stage 2 intercepted correctly with exit 3."

# Test 4: Injected stage 3 fault (permission contract violation) -> expect exit 4
echo "[4/4] Testing stage 3 fault injection (expect exit 4)..."
set +e
OUTPUT=$(node scripts/verify-archive-smoke.mjs --inject-fail-stage-3 --json 2>/dev/null)
EXIT_CODE=$?
set -e
if [ "$EXIT_CODE" -ne 4 ]; then
  echo "FAIL: Expected exit 4, got $EXIT_CODE"
  exit 1
fi
STAGE=$(echo "$OUTPUT" | jq -r '.failed_stage')
if [ "$STAGE" != "permission_and_data" ]; then
  echo "FAIL: Expected failed_stage permission_and_data, got $STAGE"
  exit 1
fi
echo "  -> OK: Stage 3 intercepted correctly with exit 4."

echo "================================================="
echo "ALL 4 VERIFICATION MATRIX CHECKS PASSED (exit 0)!"
echo "================================================="
