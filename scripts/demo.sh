#!/usr/bin/env bash
# End-to-end demo of the Time-Off Microservice using only curl.
# Usage:
#   1) Terminal A:  npm run start:dev
#   2) Terminal B:  ./scripts/demo.sh
set -euo pipefail
HOST="${HOST:-http://localhost:3000}"

step() { printf "\n\033[1;36m=== %s ===\033[0m\n" "$*"; }
say()  { printf "  %s\n" "$*"; }
api()  { local m="$1" p="$2"; shift 2; curl -s -w "\n[HTTP %{http_code}]\n" -X "$m" "$HOST$p" "$@"; }

step "0. Health"
api GET /healthz

step "1. Seed Mock HCM and ReadyOn"
api POST /admin/seed \
  -H 'content-type: application/json' \
  --data @"$(dirname "$0")/demo-seed.json"

step "2. Alice's balances"
api GET /employees/emp-alice/balances

step "3. Alice creates a 2-day VACATION request (with idempotency key)"
KEY="demo-$(date +%s)"
api POST /time-off-requests \
  -H 'content-type: application/json' \
  -H "Idempotency-Key: $KEY" \
  -d '{"employeeId":"emp-alice","locationId":"loc-NYC","leaveType":"VACATION","startDate":"2026-06-10","endDate":"2026-06-11","durationMinutes":960,"reason":"Family trip"}'

step "3a. Replay same key → same response, no duplicate"
api POST /time-off-requests \
  -H 'content-type: application/json' \
  -H "Idempotency-Key: $KEY" \
  -d '{"employeeId":"emp-alice","locationId":"loc-NYC","leaveType":"VACATION","startDate":"2026-06-10","endDate":"2026-06-11","durationMinutes":960,"reason":"Family trip"}'

step "4. Alice's balances now show 960m reserved"
api GET /employees/emp-alice/balances

step "5. Manager approves; HCM file is queued in the outbox"
REQ_ID=$(curl -s "$HOST/employees/emp-alice/time-off-requests" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['items'][0]['id'])")
say "request id: $REQ_ID"
api POST "/time-off-requests/$REQ_ID/approve" \
  -H 'content-type: application/json' \
  -d '{"managerId":"mgr-1"}'

step "6. Manually flush the outbox to file with HCM"
api POST /admin/outbox/flush

step "7. Alice's balance: HCM and reserved now both reflect the deduction"
api GET /employees/emp-alice/balances

step "8. Anniversary bonus from HR — bump HCM balance by +480m"
api POST /mock-hcm/admin/bump-balance \
  -H 'content-type: application/json' \
  -d '{"hcmEmployeeId":"wd-alice","hcmLocationId":"wd-loc-NYC","leaveType":"VACATION","deltaMinutes":480}'

step "9. Webhook the change into the service"
api POST /webhooks/hcm/balance-updated \
  -H 'content-type: application/json' \
  -d '{"hcmEmployeeId":"wd-alice","hcmLocationId":"wd-loc-NYC","leaveType":"VACATION","balanceMinutes":4320,"version":"anniv-v1"}'

step "10. Drift simulation: change HCM directly (no webhook), then full-sync repairs"
api POST /mock-hcm/admin/seed-balance \
  -H 'content-type: application/json' \
  -d '{"hcmEmployeeId":"wd-alice","hcmLocationId":"wd-loc-NYC","leaveType":"VACATION","balanceMinutes":9000}'
api POST /admin/sync/full

step "11. Final balances"
api GET /employees/emp-alice/balances

step "Done."
