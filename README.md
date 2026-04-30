# ReadyOn — Time-Off Microservice

A NestJS + SQLite backend that owns the lifecycle of time-off requests for ReadyOn while keeping balances eventually consistent with the customer's HCM (Human Capital Management) system of record (Workday, SAP, BambooHR, …).

> **Read the [TRD](./TRD.md) first.** It explains *why* the system is shaped the way it is — the trade-offs, the failure modes, and the alternatives considered.

---

## What this service guarantees

| Property | Mechanism |
|---|---|
| **No double-spend** under concurrency | `BEGIN IMMEDIATE` SQLite transactions with optimistic versioning on the `balances` row |
| **No request loss** when HCM is down | Outbox pattern — every HCM-bound write is enqueued in the same transaction that mutates the request, then drained with exponential-backoff retry |
| **Self-healing drift** | Periodic full-sync against HCM batch endpoint + inbound webhook + per-employee on-demand reconcile |
| **Auditability** | Append-only `balance_ledger` table with one row per balance change, including `cause`, `actor`, `request_id`, before/after values |
| **Idempotent writes** | `Idempotency-Key` header → `idempotency_keys` table stores response; replays return the original answer; mismatched bodies → `409 IDEMPOTENCY_REPLAY` |
| **Anniversary-safe** | HCM webhooks/reconciles only overwrite `hcm_balance_minutes`; in-flight reservations are preserved unconditionally |

## Architecture at a glance

```
┌──────────┐  REST  ┌─────────────────────────────────────────────┐
│ ReadyOn  │ ─────▶ │ Controllers ─▶ Services ─▶ better-sqlite3   │
│ clients  │        │                              │ │            │
└──────────┘        │   ┌──────────────────────────▼─┘            │
                    │   │ employees / balances / requests         │
                    │   │ ledger / outbox / idempotency_keys      │
                    │   └─────────────────────────────────────────┘
                    │             ▲                   ▲           │
                    │             │ outbox flush      │ webhook /  │
                    │             │ (at-least-once)   │ batch pull │
                    └─────────────┼───────────────────┼────────────┘
                                  ▼                   ▼
                            ┌─────────────────────────────────┐
                            │     HcmClient (interface)       │
                            │  - MockHcmService (in-process)  │
                            │  - Workday / SAP adapters (TBD) │
                            └─────────────────────────────────┘
```

## Quick start

```bash
npm install
npm run start:dev
# → http://localhost:3000
# → http://localhost:3000/docs   (Swagger)
# → http://localhost:3000/healthz
```

The service ships with an **in-process Mock HCM** that holds its own balance state, so the entire system is runnable end-to-end with no external dependency. Production configurations would swap `MockHcmService` for a Workday or SAP adapter via DI.

## API surface

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/healthz` | Liveness |
| `GET`  | `/employees/:id/balances` | List an employee's balances per location/leave-type |
| `GET`  | `/employees/:id/balances/:locationId/:leaveType` | Single balance |
| `GET`  | `/employees/:id/time-off-requests` | List requests |
| `GET`  | `/time-off-requests/:id` | Single request |
| `POST` | `/time-off-requests` | Create a request (accepts `Idempotency-Key`) |
| `POST` | `/time-off-requests/:id/approve` | Manager approval |
| `POST` | `/time-off-requests/:id/cancel` | Cancel |
| `POST` | `/webhooks/hcm/balance-updated` | Inbound HCM webhook |
| `POST` | `/admin/sync/full` | Full reconcile against HCM batch |
| `POST` | `/admin/sync/employee/:id` | Reconcile a single employee |
| `POST` | `/admin/outbox/flush` | Manually drain the outbox (used in tests/admin) |

Errors follow `application/problem+json` shape: `{ type, title, status, code, detail, message }`.

## Data model (SQLite)

```
employees(id, hcm_employee_id, name, created_at)
locations(id, hcm_location_id, name)

balances(
  employee_id, location_id, leave_type,
  hcm_balance_minutes,        -- HCM truth at last sync
  reserved_minutes,           -- held by in-flight requests
  version,                    -- optimistic-lock counter
  hcm_version, last_synced_at,
  PK (employee_id, location_id, leave_type)
)

time_off_requests(id, employee_id, location_id, leave_type,
                  start_date, end_date, duration_minutes,
                  status, reason, hcm_request_id,
                  idempotency_key, created_at, updated_at)

balance_ledger(... append-only audit log ...)
outbox(... durable HCM-side-effect queue with backoff ...)
idempotency_keys(...)
hcm_webhook_events(... dedupe HCM webhooks ...)
```

The crucial design property: **`reserved_minutes` is local-only and survives every HCM update**. Anniversary bonuses, manual HR edits, and full-corpus reconciles only ever touch `hcm_balance_minutes`. See [TRD §8.2](./TRD.md#82-balance-state-machine).

## Running tests

```bash
npm test                 # unit + e2e in one Jest run
npm run test:cov         # same, with coverage and threshold gates
npm run test:e2e         # only the e2e spec files
npm run lint             # ESLint (clean)
npm run build            # Nest build (clean)
```

### Coverage gates

| Metric | Threshold | Achieved |
|---|---|---|
| lines | ≥ 90% | ✓ |
| statements | ≥ 90% | ✓ |
| functions | ≥ 90% | ✓ |
| branches | ≥ 75% | ✓ |

Branches hover ~79% — the residual is dominated by defensive concurrency-conflict paths and scheduler timer callbacks that aren't deterministically testable without contrived setups; these are exercised in production by the same code paths that the existing tests cover from the success side.

### Test catalogue

| File | What it covers |
|---|---|
| `src/balances/balances.service.spec.ts` | Reserve / release / settle / HCM-update math, ledger writes, anniversary preservation, clamping |
| `src/common/idempotency.service.spec.ts` | Body canonicalisation, replay detection, route-mismatch detection |
| `src/common/errors.spec.ts` | Every domain-error factory has the right HTTP status & code |
| `src/employees/employees.service.spec.ts` | Upsert idempotency, name updates, list ordering, NotFound paths |
| `src/hcm/mock-hcm.service.spec.ts` | Mock semantics, idempotent file/cancel, paged listing, fault-injection knobs |
| `src/sync/outbox.service.spec.ts` | Backoff schedule, dead-lettering after max attempts, no-op flush |
| `src/sync/sync.service.spec.ts` | Webhook dedupe & unknown-employee handling, full sync drift repair, per-employee reconcile, new-employee discovery |
| `src/time-off/time-off.service.spec.ts` | Lifecycle: create → approve → flush → settle; cancel paths (PENDING / APPROVED-not-yet-filed / APPROVED-and-filed); HCM-disagreement-at-approve; permanent failure releases reservation |
| `test/time-off.e2e-spec.ts` | Full HTTP happy path, idempotency replay, validation rejection, insufficient-balance |
| `test/concurrency.e2e-spec.ts` | **100 concurrent requests → exactly N succeed where N×duration ≤ balance** |
| `test/hcm-failures.e2e-spec.ts` | Transient HCM during file → eventual success after retries; permanent → request FAILS, reservation released; transient HCM during approve → 503 |
| `test/sync.e2e-spec.ts` | Webhook over HTTP, anniversary bump preserves reservations, full-sync repairs missed-webhook drift |
| `test/api-errors.e2e-spec.ts` | 404s, illegal transitions, list endpoint, admin/sync/employee |

## Configuration

| Env var | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `:memory:` | SQLite path (use `./data.sqlite` for persistence) |
| `OUTBOX_INTERVAL_MS` | `1000` | How often the scheduler drains the outbox |
| `FULL_SYNC_INTERVAL_MS` | `900000` (15 min) | Periodic full reconcile |
| `DISABLE_SCHEDULER` | unset | Set to `1` in tests to drive timing manually |

## Project layout

```
src/
  app.module.ts               composition root
  main.ts                     bootstrap (Swagger, validation pipes)
  health.controller.ts
  common/                     Clock, IdempotencyService, DomainError
  db/                         DbService (better-sqlite3) + migrations
  domain/                     LeaveType, RequestStatus, row/view types
  employees/                  Employee + Location upserts and lookups
  balances/                   Balance state machine (the heart)
  time-off/                   TimeOffService — request lifecycle
  hcm/                        HcmClient interface + MockHcmService
  sync/                       OutboxService, SyncService, SchedulerService

test/                         e2e specs + harness
TRD.md                        Technical Requirements Document
```

## Production readiness checklist

This is a v1; before customer-facing deployment we'd need to add (none of which require core changes):

- [ ] Replace SQLite with Postgres (the schema and outbox carry over unchanged).
- [ ] Authentication (JWT/IAM gateway in front).
- [ ] HMAC verification on the inbound HCM webhook.
- [ ] Per-tenant isolation (tenant_id everywhere or DB-per-tenant).
- [ ] Real Workday and SAP adapters implementing `HcmClient`.
- [ ] Prometheus exporter for the metrics described in [TRD §11](./TRD.md#11-observability).
- [ ] Multi-instance outbox claim (e.g., `SELECT … FOR UPDATE SKIP LOCKED`) — currently single-writer.

## License

UNLICENSED — internal ReadyOn property.
