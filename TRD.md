# Technical Requirements Document — ReadyOn Time-Off Microservice

> Status: v1.0 — author: ReadyOn Platform Team — last updated: 2026-04-30

---

## 1. Background

ReadyOn is the front-of-house Time-Off product employees and managers interact with daily. The customer's **Human Capital Management (HCM)** system — Workday, SAP SuccessFactors, BambooHR, etc. — remains the **System of Record (SoR)** for employment data, including the *authoritative* time-off balance.

This document specifies the **Time-Off Microservice** that:

1. Owns the **lifecycle of time-off requests** created in ReadyOn.
2. Maintains **balance integrity** between ReadyOn's view and the HCM SoR.
3. Exposes a clean REST API for the ReadyOn web/mobile clients.
4. Is **defensive** against HCM availability, ordering, and consistency anomalies.

## 2. Glossary

| Term | Meaning |
|---|---|
| HCM | Customer's Human Capital Management system (Workday, SAP, …). Authoritative source of employment data. |
| Balance | An employee's available time-off, scoped per `(employee, location, leave_type)`. Stored in **minutes** to avoid fractional-day arithmetic. |
| Reservation | Minutes provisionally held by an in-flight `PENDING`/`APPROVED` ReadyOn request before HCM confirms the deduction. |
| Effective Available | `hcm_balance_minutes − reserved_minutes`. The figure shown to employees. |
| Idempotency Key | Client-supplied `Idempotency-Key` header; guarantees a `POST` is processed at-most-once per (route, key). |
| Outbox | Durable queue of pending HCM side-effects, for at-least-once delivery with retry. |

## 3. Goals & Non-Goals

### 3.1 Goals
- **G1** Provide a REST API for ReadyOn clients to view balances and submit/approve/cancel time-off requests.
- **G2** Keep ReadyOn's view of balance **eventually consistent** with HCM. Detect and self-heal divergence.
- **G3** Be **defensive against HCM**: tolerate downtime, slow responses, missing webhooks, and conflicting concurrent updates without corrupting balances or losing requests.
- **G4** Be **internally consistent**: no double-spend across concurrent requests for the same employee.
- **G5** Provide an **auditable ledger** of every change to a balance.
- **G6** Be **vendor-agnostic** — HCM access is through one interface (`HcmClient`) so adding Workday, SAP, etc. is a new adapter, not a rewrite.

### 3.2 Non-Goals (v1)
- Multi-tenant isolation (single-tenant deployment per customer).
- Approval *workflows* beyond a single manager step.
- Holidays, accrual policy engine — accrual is owned by HCM.
- Full Workday/SAP adapter implementation (an in-process **mock HCM** is shipped for tests).
- UI; this is a backend microservice.

## 4. Personas & Top User Stories

| Persona | Story | API Surface |
|---|---|---|
| Employee | "Show me my available PTO so I can request 2 days off, and tell me immediately if it succeeded." | `GET /employees/:id/balances`, `POST /time-off-requests` |
| Manager  | "Approve Alice's request, but only if HCM still agrees she has the balance." | `POST /time-off-requests/:id/approve` |
| Employee | "Cancel a request and get my balance back." | `POST /time-off-requests/:id/cancel` |
| HCM      | "Balance just changed (anniversary bonus / manual HR edit) — please reflect it." | `POST /webhooks/hcm/balance-updated` |
| Ops      | "Re-sync this employee, or all employees, against HCM." | `POST /admin/sync/employee/:id`, `POST /admin/sync/full` |

## 5. Interesting Challenges & Mitigations

The brief calls these out explicitly; the table below maps each to a design decision in this TRD.

| # | Challenge | Mitigation | Section |
|---|---|---|---|
| C1 | "ReadyOn is not the only system that updates HCM" — anniversary bonus, year-start refresh, HR-side edits | **Webhook in** + **periodic batch reconcile** + **per-balance `hcm_version`/`last_synced_at`**. Batch sync is the safety-net if webhooks are missed. | §8.4, §8.5 |
| C2 | HCM realtime API for individual `(employee, location)` reads and writes | Use realtime read **at approval time** (defensive re-check) and on-demand for stale rows; realtime write **post-approve** via outbox. | §8.3, §9.4 |
| C3 | HCM batch endpoint for full corpus | Scheduled job (cron) consumes batch; reconciliation engine merges with local state without clobbering live reservations. | §8.5 |
| C4 | "HCM may send back errors on invalid combinations or insufficient balance — but not always guaranteed" | Treat HCM errors as authoritative when present, but **do not rely on them**. Validate locally first (defense-in-depth), reconcile after. | §8.3, §10 |

## 6. Success Criteria

A submission is "good" if it can answer **yes** to all of:

1. **No double-spend**: 100 concurrent `POST /time-off-requests` for the same employee whose balance only allows 50 — exactly 50 succeed, 50 are rejected with `409 INSUFFICIENT_BALANCE`. (E2E test `concurrency.e2e-spec.ts`.)
2. **No request loss**: if HCM is down when an approval is filed, the request is *not* rejected; it is queued and eventually delivered. (E2E test `hcm-failures.e2e-spec.ts`.)
3. **Self-healing**: if the local balance drifts (e.g., webhook missed), running the periodic reconcile restores parity without losing in-flight reservations. (E2E test `sync.e2e-spec.ts`.)
4. **Auditable**: every balance mutation has a row in `balance_ledger` with the cause, actor and prior/new values.
5. **Idempotent writes**: replaying the same `POST` with the same `Idempotency-Key` returns the original response, never duplicates work.
6. **Coverage**: lines/branches ≥ 85% on the `src/` tree (excluding bootstrap files), evidenced by `npm run test:cov`.

## 7. High-Level Architecture

```
┌──────────────────┐    REST/JSON      ┌──────────────────────────────────────────┐
│  ReadyOn client  │ ───────────────▶  │           Time-Off Microservice          │
└──────────────────┘                   │                                          │
                                       │  ┌──────────────┐  ┌──────────────────┐  │
                                       │  │ Controllers  │  │ TimeOffService   │  │
                                       │  │ (Nest)       │──▶│ BalancesService │  │
                                       │  └──────────────┘  │ SyncService     │  │
                                       │                    │ HcmClient       │  │
                                       │                    └────────┬─────────┘  │
                                       │  ┌──────────────────────────▼─────────┐  │
                                       │  │ SQLite (better-sqlite3, WAL mode)  │  │
                                       │  │ employees | balances | requests |  │
                                       │  │ ledger    | outbox   | idempotency │  │
                                       │  └────────────────────────────────────┘  │
                                       └──────────┬───────────────────▲───────────┘
                                                  │ outbox flush      │ webhook /
                                                  ▼ (at-least-once)   │ batch pull
                                       ┌─────────────────────────────────────────┐
                                       │   HCM (Workday/SAP) — Mock in tests     │
                                       └─────────────────────────────────────────┘
```

## 8. Detailed Design

### 8.1 Data Model

All money-like values (balance) are stored as **integer minutes** to avoid IEEE-754 grief. A "day" is a tenant-configurable constant (default 480 min = 8h) but the service never assumes it.

```text
employees(
    id TEXT PRIMARY KEY,            -- ReadyOn UUID
    hcm_employee_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
)

locations(
    id TEXT PRIMARY KEY,
    hcm_location_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL
)

balances(
    employee_id TEXT NOT NULL REFERENCES employees(id),
    location_id TEXT NOT NULL REFERENCES locations(id),
    leave_type TEXT NOT NULL,                 -- VACATION | SICK | PERSONAL | …
    hcm_balance_minutes INTEGER NOT NULL,     -- HCM truth at last_synced_at
    reserved_minutes    INTEGER NOT NULL DEFAULT 0,
    version             INTEGER NOT NULL DEFAULT 0,    -- optimistic-lock
    hcm_version         TEXT,                          -- ETag from HCM, if any
    last_synced_at      TEXT NOT NULL,
    PRIMARY KEY (employee_id, location_id, leave_type)
)

time_off_requests(
    id TEXT PRIMARY KEY,
    employee_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    leave_type  TEXT NOT NULL,
    start_date  TEXT NOT NULL,        -- ISO date, inclusive
    end_date    TEXT NOT NULL,        -- ISO date, inclusive
    duration_minutes INTEGER NOT NULL,
    status TEXT NOT NULL,             -- PENDING | APPROVED | REJECTED | CANCELLED | FAILED
    reason TEXT,
    hcm_request_id TEXT,              -- assigned after HCM file
    idempotency_key TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (idempotency_key)
)

balance_ledger(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    leave_type TEXT NOT NULL,
    delta_minutes INTEGER NOT NULL,
    hcm_balance_after INTEGER NOT NULL,
    reserved_after    INTEGER NOT NULL,
    cause TEXT NOT NULL,              -- REQUEST_CREATED | REQUEST_APPROVED | REQUEST_CANCELLED | HCM_WEBHOOK | HCM_RECONCILE | MANUAL_ADJUST
    request_id TEXT,
    actor TEXT,                       -- system | employee:<id> | manager:<id> | hcm
    note TEXT,
    created_at TEXT NOT NULL
)

outbox(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,               -- HCM_FILE_TIMEOFF | HCM_CANCEL_TIMEOFF
    payload_json TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error TEXT,
    status TEXT NOT NULL,             -- PENDING | DONE | DEAD
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)

idempotency_keys(
    key TEXT PRIMARY KEY,
    route TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_status INTEGER NOT NULL,
    response_body TEXT NOT NULL,
    created_at TEXT NOT NULL
)
```

**Invariants enforced by the schema/transaction layer**:
- `hcm_balance_minutes ≥ 0`
- `reserved_minutes ≥ 0`
- `reserved_minutes ≤ hcm_balance_minutes` (i.e., we never reserve more than HCM says we have)
- `version` increments on every write; concurrent writers detect conflicts and retry once or fail with `409`.

### 8.2 Balance State Machine

```
        +-----------------------------+
        |  hcm_balance_minutes  (truth from HCM)
        |  - reserved_minutes   (held by in-flight requests)
        |  = effective_available (what we show users)
        +-----------------------------+
```

| Action | hcm_balance | reserved | Notes |
|---|---|---|---|
| `POST /time-off-requests` (PENDING) | unchanged | **+duration** | Validated against `effective_available`. |
| `POST /…/approve` | unchanged (yet) | unchanged | Outbox row enqueued to file with HCM. |
| Outbox flush succeeds | **−duration** | **−duration** | HCM has now deducted. Net effect: effective_available unchanged from before approve, but now reflects HCM truth. |
| `POST /…/cancel` (was PENDING) | unchanged | **−duration** | No HCM call needed. |
| `POST /…/cancel` (was APPROVED + filed) | **+duration** (after HCM cancel) | unchanged | HCM cancel call. If APPROVED but unfiled (still in outbox), revoke outbox row and **−reserved**. |
| HCM webhook `balance.updated` | **= new value from HCM** | unchanged | Reservations preserved across HCM updates (anniversary, manual edits). |
| Periodic reconcile | **= HCM batch value** | unchanged | Same as webhook; `last_synced_at` updated. |

The crucial property: **reservations are local-only and independent of HCM's balance value**. Anniversaries, manual HR adjustments, and other external HCM movements only change `hcm_balance_minutes`. We never "re-reserve" against the new value because the reservation already exists.

### 8.3 Request Lifecycle

```
            +--------- reject (insufficient balance, …) ---------+
            |                                                    |
client ──▶ PENDING ──manager approve──▶ APPROVED ──outbox file──▶ APPROVED+filed
            │                              │
            ├──cancel─▶ CANCELLED          ├──cancel ──▶ CANCELLED (HCM cancel via outbox)
            │                              │
            └──HCM rejects (final)─▶ FAILED (reservation released, ledger entry)
```

Defensive checks at each transition:
1. **Create**: validate dates, leave_type, duration > 0, reserve **inside a SQLite transaction** with optimistic version check. Rejected with `409 INSUFFICIENT_BALANCE` if reservation would violate invariant.
2. **Approve**: re-fetch HCM realtime balance for this `(employee, location, leave_type)`; if HCM disagrees, reconcile **first**, then re-evaluate. If still sufficient, mark APPROVED + enqueue outbox; else mark FAILED.
3. **Outbox flush**: send to HCM. On 4xx (client error → permanent), mark request FAILED, release reservation. On 5xx/timeout (transient), retry with exponential backoff (`1s, 5s, 30s, 2m, 10m`, max 8 attempts → DEAD letter, alert).
4. **Cancel**: idempotent; releases reservation or schedules HCM cancel.

### 8.4 HCM Webhook Path (Inbound)

`POST /webhooks/hcm/balance-updated`

```json
{
  "hcm_employee_id": "wd-1234",
  "hcm_location_id": "loc-NYC",
  "leave_type": "VACATION",
  "balance_minutes": 7200,
  "version": "etag-abc",
  "occurred_at": "2026-04-30T15:00:00Z"
}
```

- Authenticated via shared HMAC header (`X-HCM-Signature`).
- Looked up by `hcm_employee_id` + `hcm_location_id` (NOT ReadyOn IDs).
- Idempotent on `(hcm_employee_id, hcm_location_id, leave_type, version)`.
- **Only updates `hcm_balance_minutes`**; reservations are preserved.
- Writes a `HCM_WEBHOOK` ledger row.

### 8.5 Batch Reconciliation (Outbound Pull)

Runs on a schedule (default: every 15 min) and on-demand via `POST /admin/sync/full`:

1. `GET /hcm/balances/full` from the HCM client (paginated).
2. For each `(employee, location, leave_type)` row:
   - **upsert** the balance row by HCM IDs.
   - **only `hcm_balance_minutes` is overwritten**; `reserved_minutes` is untouched (see §8.2).
   - if the row didn't exist locally, create employee/location stubs.
3. If a local balance has no corresponding HCM row, log a warning (don't delete — could be a paginated gap).
4. Single `HCM_RECONCILE` ledger entry per changed row.

### 8.6 Outbox / Outbound HCM Calls

All writes to HCM (file-time-off, cancel-time-off) flow through the outbox:

- Same SQL transaction that mutates a request also inserts the outbox row → at-least-once delivery is guaranteed even if the process crashes mid-call.
- A scheduler polls `outbox WHERE status = 'PENDING' AND next_attempt_at <= now` every 1s.
- Per-request work is keyed on `request_id` so duplicate flushes are no-ops (HCM client uses an idempotency-key derived from the request id).
- Errors: 4xx → permanent fail (request → FAILED, reservation released); 5xx/timeout → backoff and retry; > 8 attempts → status DEAD + alert.

### 8.7 HCM Transport & Vendor Strategy

The `HcmClient` abstract class is the single seam between ReadyOn's
business logic and any HCM vendor. The provider is selected at boot from
`HCM_PROVIDER`:

| `HCM_PROVIDER` | Implementation | Use |
|---|---|---|
| `mock` *(default)* | `MockHcmService` (in-process) | Unit tests, e2e tests, local dev without spinning a separate process |
| `http` | `HttpHcmClient(baseUrl)` | Speaks the same REST shape as our Mock HCM; used to *prove* the abstraction works over the wire and to point at a real HCM that exposes our shape |
| `workday` | `WorkdayHcmClient(tenantUrl, bearerToken)` | Stub today; production adapter placeholder |
| `sap` | `SapHcmClient(oDataBaseUrl, oauthClientId, oauthClientSecret)` | Stub today; production adapter placeholder |

`HttpHcmClient` classifies HCM responses into `HcmTransientError` (5xx,
408, 429, network errors, timeout) and `HcmPermanentError` (4xx). The
outbox's retry/dead-letter logic and the approve-time defensive check are
implemented strictly against those two error types, so swapping vendors
never changes business code.

The Mock HCM is mounted in the same Nest app at `/mock-hcm/*` whenever
`ENABLE_MOCK_HCM=1` (default in dev). It exposes the same wire-protocol
the `HttpHcmClient` consumes, plus admin endpoints that simulate
anniversary bumps, transient outages, and permanent failures. Reviewers
can curl it directly to inspect or perturb HCM-side state.

### 8.8 Deployment Topology

```
                         ┌─────────────────────────────────┐
   ReadyOn               │  Time-Off Service (Nest)        │
   clients ─────HTTP────▶│  Controllers ─► Services ─► DB  │
                         │                       │         │
                         │                       ▼         │
                         │            HcmClient (interface)│
                         │                       │         │
                         └───────────────────────┼─────────┘
                                                 │
                            ┌────────────────────┼────────────────────┐
                            ▼                    ▼                    ▼
               in-process MockHcmService   HttpHcmClient ─HTTP→  Mock HCM (same
               (test default)              Workday/SAP adapter   process or own)
```

Two supported deployment shapes:

1. **Single-process dev/CI**: ReadyOn + Mock HCM in one Nest app, mounted
   at `/mock-hcm/*`. `HCM_PROVIDER=mock` short-circuits the HTTP loop.
2. **Two-process integration**: ReadyOn in one process with
   `HCM_PROVIDER=http HCM_BASE_URL=https://hcm.dev.example`, Mock HCM
   running in another (or a real HCM). The Time-Off Service code is
   unchanged.

## 9. Public API

### 9.1 Conventions
- All endpoints are JSON.
- Errors follow `application/problem+json` shape: `{ type, title, status, detail, code }`.
- Mutating endpoints accept `Idempotency-Key` header.
- All times ISO-8601 UTC. All durations integer minutes.

### 9.2 Endpoints

| # | Method | Path | Description | Auth (v1) |
|---|---|---|---|---|
| 1 | `GET`  | `/employees/:employeeId/balances` | List balances by location & leave type | employee |
| 2 | `GET`  | `/employees/:employeeId/balances/:locationId/:leaveType` | Single balance | employee |
| 3 | `POST` | `/time-off-requests` | Create a request (idempotent) | employee |
| 4 | `GET`  | `/time-off-requests/:id` | Read a request | employee/manager |
| 5 | `GET`  | `/employees/:employeeId/time-off-requests` | List employee's requests | employee/manager |
| 6 | `POST` | `/time-off-requests/:id/approve` | Manager approves | manager |
| 7 | `POST` | `/time-off-requests/:id/cancel` | Cancel | employee |
| 8 | `POST` | `/webhooks/hcm/balance-updated` | HCM webhook in | HMAC |
| 9 | `POST` | `/admin/sync/full` | Trigger full reconcile | ops |
| 10| `POST` | `/admin/sync/employee/:employeeId` | Reconcile one employee | ops |
| 11| `GET`  | `/healthz` | Liveness | none |
| 12| `POST` | `/admin/seed` | Dev/demo seeding (HCM + ReadyOn in one shot) | ops/dev |
| 13| `POST` | `/admin/outbox/flush` | Drain the outbox synchronously (tests/admin) | ops |
| 14| `*` | `/mock-hcm/*` | Mock-HCM HTTP surface (toggle with `ENABLE_MOCK_HCM`) | dev |

(v1 ignores auth implementation; tests stub roles via header. Production would put a JWT/IAM in front.)

### 9.3 Request: Create Time-Off

```http
POST /time-off-requests
Content-Type: application/json
Idempotency-Key: 5e8b3f7a-…
{
  "employeeId": "emp-1",
  "locationId": "loc-NYC",
  "leaveType": "VACATION",
  "startDate": "2026-06-10",
  "endDate":   "2026-06-12",
  "durationMinutes": 1440,
  "reason": "Family trip"
}
→ 201 Created
{
  "id": "req-…",
  "status": "PENDING",
  "balanceAfter": { "available": 6720, "reserved": 1440, "hcm": 8160 }
}
→ 409 INSUFFICIENT_BALANCE | 409 IDEMPOTENCY_REPLAY (same key, different body) | 422 INVALID
```

### 9.4 Request: Approve

```http
POST /time-off-requests/abc/approve
Idempotency-Key: …
{ "managerId": "mgr-7" }
→ 200 OK { "id": "abc", "status": "APPROVED" }
→ 409 INSUFFICIENT_BALANCE   (HCM disagrees on re-check; balance was reconciled)
→ 409 ILLEGAL_TRANSITION     (already approved/cancelled/failed)
```

Approval re-validates against HCM realtime; if HCM rejects, the request is marked FAILED and the reservation released. 

## 10. Failure-Mode Catalogue

| Scenario | Detection | System Response |
|---|---|---|
| HCM 5xx during `POST /…/approve` realtime check | Catch in `HcmClient` | Approval *blocked* (return 503), reservation kept (transient). Caller can retry. |
| HCM 5xx during outbox flush | Catch + retry | Exponential backoff up to 8 attempts. After max, request goes FAILED, reservation released, ops alerted. |
| HCM webhook arrives out-of-order | Compare `version`/`occurred_at` vs `last_synced_at` | Older event → ignored (logged). |
| HCM webhook missing entirely | Periodic batch sync | Reconciliation re-bases `hcm_balance_minutes` against HCM corpus. |
| Two concurrent requests for same employee | SQLite transaction + optimistic version | One wins; the other sees a stale version, retries inside the same call once, may then fail with 409. |
| Idempotency-Key replayed with different body | Stored `request_hash` mismatch | 409 IDEMPOTENCY_REPLAY. |
| HCM declares balance went negative (data error) | Invariant check | Coerce to 0, log critical, raise alert. Don't crash. |
| Ledger / balance drift detected on reconcile | `hcm_balance_minutes` diff > tolerance | Apply HCM value, write `HCM_RECONCILE` ledger with diff in `note`. |

## 11. Observability

- Structured JSON logs (Nest `Logger` with a JSON formatter override) keyed by `correlationId`, `employeeId`, `requestId`.
- Metrics (counter/histogram naming, exposed by a `/metrics` Prom endpoint in prod):
  - `timeoff_requests_total{status}`
  - `balance_reconciliation_drift_minutes`
  - `hcm_call_duration_seconds{op,outcome}`
  - `outbox_depth`
  - `idempotency_hits_total`
- Audit trail = `balance_ledger` table; never mutated, only appended.

## 12. Alternatives Considered

| Alternative | Why rejected |
|---|---|
| **Treat HCM as live, no local balance store.** Every read passes through HCM. | High latency on every UI poll; total dependency on HCM uptime; impossible to enforce reservation atomicity across concurrent submissions. |
| **Two-phase commit with HCM.** | HCM systems do not expose 2PC. Operationally infeasible. |
| **Use a message broker (Kafka, SQS) for HCM sync.** | Adds infra footprint not justified at the per-tenant scale of v1; the same at-least-once + outbox guarantees are achievable in-DB with one less moving part. SQLite outbox migrates trivially to Postgres `LISTEN/NOTIFY` or SQS in v2. |
| **Store balances as floats / decimals of days.** | Floating-point drift, locale-dependent rounding, fractional half-days. Integer minutes is universal. |
| **Skip the ledger; derive history from `requests`.** | Anniversary bonuses and manual HR edits don't have requests; we'd lose audit. |
| **Single big `balances` table without `version`.** | Concurrent submissions corrupt; we'd need full-row pessimistic locks which SQLite gates per-DB anyway. Optimistic version is portable to Postgres. |
| **Pessimistic locks (SQLite `BEGIN IMMEDIATE`) for everything.** | Used internally for the critical balance-mutation transaction; not exposed at the API layer because it serializes the whole employee. Optimistic + retry is the public-facing strategy. |

## 13. Test Plan

| Layer | What is tested | Files |
|---|---|---|
| Unit | Balance math, reservation invariants, idempotency hashing, duration utils, outbox state machine | `*.spec.ts` co-located with services |
| Mock HCM | The mock obeys realistic semantics (rejects negative, simulates anniversary bump, simulates 5xx) | `hcm/hcm-mock.service.spec.ts` |
| E2E happy path | Create → approve → ledger has 2 rows; HCM gets a file call. | `test/time-off.e2e-spec.ts` |
| E2E concurrency | 100 parallel creates, only N succeed where N×duration ≤ balance. | `test/concurrency.e2e-spec.ts` |
| E2E HCM down | Approve while HCM is 5xx → outbox retries, eventually succeeds. | `test/hcm-failures.e2e-spec.ts` |
| E2E webhook | Anniversary bonus webhook lands → balance grows, reservations preserved. | `test/webhook.e2e-spec.ts` |
| E2E reconcile | Local drifts; full sync repairs without losing reservations. | `test/sync.e2e-spec.ts` |
| E2E idempotency | Replay with same key returns same response. | `test/idempotency.e2e-spec.ts` |
| Coverage | `npm run test:cov` ≥ 85% lines/branches on `src/`. | `coverage/lcov-report` |

## 14. Open Questions / Future Work

- Multi-tenant deployment story (per-tenant DB vs shared schema with `tenant_id`).
- Replace SQLite with Postgres for production; outbox model carries over with no app-code change.
- Event bus (Kafka) for cross-service balance updates (e.g., payroll).
- Approval workflows beyond single-step.
- Rich leave-type policy (carry-over caps, blackout dates) — currently in HCM.
- Flesh out `WorkdayHcmClient` and `SapHcmClient` (stubs in v1 — see §8.7).
- HMAC verification on `/webhooks/hcm/balance-updated`.
- Replace single-writer outbox poller with `SELECT … FOR UPDATE SKIP LOCKED`-style claim once on Postgres.

---

*End of TRD v1.0.*
