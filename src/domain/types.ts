export type LeaveType = 'VACATION' | 'SICK' | 'PERSONAL' | 'BEREAVEMENT';

export const LEAVE_TYPES: LeaveType[] = [
  'VACATION',
  'SICK',
  'PERSONAL',
  'BEREAVEMENT',
];

export type RequestStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'FAILED';

export const REQUEST_STATUSES: RequestStatus[] = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'FAILED',
];

export type LedgerCause =
  | 'REQUEST_CREATED'
  | 'REQUEST_APPROVED'
  | 'REQUEST_CANCELLED'
  | 'REQUEST_FAILED'
  | 'HCM_WEBHOOK'
  | 'HCM_RECONCILE'
  | 'MANUAL_ADJUST';

export type OutboxStatus = 'PENDING' | 'DONE' | 'DEAD';

export type OutboxType = 'HCM_FILE_TIMEOFF' | 'HCM_CANCEL_TIMEOFF';

export interface BalanceRow {
  employee_id: string;
  location_id: string;
  leave_type: LeaveType;
  hcm_balance_minutes: number;
  reserved_minutes: number;
  version: number;
  hcm_version: string | null;
  last_synced_at: string;
}

export interface BalanceView {
  employeeId: string;
  locationId: string;
  leaveType: LeaveType;
  hcmBalanceMinutes: number;
  reservedMinutes: number;
  availableMinutes: number;
  lastSyncedAt: string;
}

export interface TimeOffRequestRow {
  id: string;
  employee_id: string;
  location_id: string;
  leave_type: LeaveType;
  start_date: string;
  end_date: string;
  duration_minutes: number;
  status: RequestStatus;
  reason: string | null;
  hcm_request_id: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface TimeOffRequestView {
  id: string;
  employeeId: string;
  locationId: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  durationMinutes: number;
  status: RequestStatus;
  reason: string | null;
  hcmRequestId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OutboxRow {
  id: number;
  type: OutboxType;
  payload_json: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  status: OutboxStatus;
  created_at: string;
  updated_at: string;
}
