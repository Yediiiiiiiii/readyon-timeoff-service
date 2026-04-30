import type { Database } from 'better-sqlite3';

const DDL = `
CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  hcm_employee_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY,
  hcm_location_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS balances (
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  leave_type  TEXT NOT NULL,
  hcm_balance_minutes INTEGER NOT NULL CHECK (hcm_balance_minutes >= 0),
  reserved_minutes    INTEGER NOT NULL DEFAULT 0 CHECK (reserved_minutes >= 0),
  version             INTEGER NOT NULL DEFAULT 0,
  hcm_version         TEXT,
  last_synced_at      TEXT NOT NULL,
  PRIMARY KEY (employee_id, location_id, leave_type)
);

CREATE TABLE IF NOT EXISTS time_off_requests (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  leave_type  TEXT NOT NULL,
  start_date  TEXT NOT NULL,
  end_date    TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  status TEXT NOT NULL,
  reason TEXT,
  hcm_request_id TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_employee
  ON time_off_requests(employee_id, status);

CREATE TABLE IF NOT EXISTS balance_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  leave_type  TEXT NOT NULL,
  delta_minutes INTEGER NOT NULL,
  hcm_balance_after INTEGER NOT NULL,
  reserved_after    INTEGER NOT NULL,
  cause TEXT NOT NULL,
  request_id TEXT,
  actor TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_employee
  ON balance_ledger(employee_id, location_id, leave_type, created_at);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  status TEXT NOT NULL,
  request_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbox_request
  ON outbox(request_id);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  route TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hcm_webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hcm_employee_id TEXT NOT NULL,
  hcm_location_id TEXT NOT NULL,
  leave_type TEXT NOT NULL,
  version TEXT,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (hcm_employee_id, hcm_location_id, leave_type, version, occurred_at)
);
`;

const RESET = `
DROP TABLE IF EXISTS hcm_webhook_events;
DROP TABLE IF EXISTS idempotency_keys;
DROP TABLE IF EXISTS outbox;
DROP TABLE IF EXISTS balance_ledger;
DROP TABLE IF EXISTS time_off_requests;
DROP TABLE IF EXISTS balances;
DROP TABLE IF EXISTS locations;
DROP TABLE IF EXISTS employees;
`;

export function runMigrations(
  db: Database,
  opts: { reset?: boolean } = {},
): void {
  if (opts.reset) {
    db.exec(RESET);
  }
  db.exec(DDL);
}
