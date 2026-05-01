import { LeaveType } from '../domain/types';

export interface HcmBalance {
  hcmEmployeeId: string;
  hcmLocationId: string;
  leaveType: LeaveType;
  balanceMinutes: number;
  version: string | null;
}

export interface HcmFileRequest {
  requestId: string;
  hcmEmployeeId: string;
  hcmLocationId: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  durationMinutes: number;
}

export interface HcmFileResponse {
  hcmRequestId: string;
}

/**
 * Adapter abstraction for any HCM (Workday, SAP, BambooHR, …).
 * Implementations must be **idempotent** on requestId for `fileTimeOff`
 * and `cancelTimeOff` so the outbox can safely retry.
 */
export abstract class HcmClient {
  /** Realtime read for one (employee, location). May return multiple leave types. */
  abstract getBalances(input: {
    hcmEmployeeId: string;
    hcmLocationId: string;
  }): Promise<HcmBalance[]>;

  /** Batch / full-corpus pull, paginated. */
  abstract listAllBalances(input: {
    cursor?: string | null;
  }): Promise<{ items: HcmBalance[]; nextCursor: string | null }>;

  /** File a time-off (decrement HCM balance). Must be idempotent on requestId. */
  abstract fileTimeOff(input: HcmFileRequest): Promise<HcmFileResponse>;

  /** Cancel a previously-filed time-off. Must be idempotent on hcmRequestId. */
  abstract cancelTimeOff(input: { hcmRequestId: string }): Promise<void>;
}

export class HcmTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HcmTransientError';
  }
}

export class HcmPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HcmPermanentError';
  }
}
