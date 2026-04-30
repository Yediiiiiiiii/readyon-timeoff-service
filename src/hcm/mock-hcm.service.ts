import { Injectable, Logger } from '@nestjs/common';
import { LeaveType } from '../domain/types';
import {
  HcmBalance,
  HcmClient,
  HcmFileRequest,
  HcmFileResponse,
  HcmPermanentError,
  HcmTransientError,
} from './hcm-client';

interface MockBalanceKey {
  hcmEmployeeId: string;
  hcmLocationId: string;
  leaveType: LeaveType;
}

interface MockBalance extends MockBalanceKey {
  balanceMinutes: number;
  version: number;
}

interface FiledRequest {
  hcmRequestId: string;
  hcmEmployeeId: string;
  hcmLocationId: string;
  leaveType: LeaveType;
  durationMinutes: number;
  cancelled: boolean;
}

/**
 * In-process HCM impostor. Holds its own truth and can be programmed by tests
 * to fail certain ops. Production code never sees this; production swaps in a
 * Workday/SAP adapter via DI.
 */
@Injectable()
export class MockHcmService extends HcmClient {
  private readonly logger = new Logger(MockHcmService.name);
  private readonly balances = new Map<string, MockBalance>();
  private readonly filed = new Map<string, FiledRequest>();
  private readonly idempotency = new Map<string, FiledRequest>();
  private nextHcmRequestSeq = 1;

  /** Programmable failure modes for tests. */
  failures = {
    fileTimeOffTransientUntil: 0,
    fileTimeOffPermanent: false,
    getBalancesTransient: false,
    listAllTransient: false,
  };

  reset() {
    this.balances.clear();
    this.filed.clear();
    this.idempotency.clear();
    this.nextHcmRequestSeq = 1;
    this.failures = {
      fileTimeOffTransientUntil: 0,
      fileTimeOffPermanent: false,
      getBalancesTransient: false,
      listAllTransient: false,
    };
  }

  seedBalance(b: MockBalanceKey & { balanceMinutes: number }) {
    const key = this.k(b);
    this.balances.set(key, {
      ...b,
      balanceMinutes: b.balanceMinutes,
      version: 1,
    });
  }

  /** Test-only: imitate an HR-side change (anniversary, manual edit). */
  bumpBalance(b: MockBalanceKey, deltaMinutes: number): MockBalance {
    const key = this.k(b);
    const cur = this.balances.get(key);
    if (!cur) {
      const created: MockBalance = {
        ...b,
        balanceMinutes: Math.max(0, deltaMinutes),
        version: 1,
      };
      this.balances.set(key, created);
      return created;
    }
    cur.balanceMinutes = Math.max(0, cur.balanceMinutes + deltaMinutes);
    cur.version += 1;
    return cur;
  }

  setBalance(b: MockBalanceKey & { balanceMinutes: number }): MockBalance {
    const key = this.k(b);
    const cur = this.balances.get(key);
    const next: MockBalance = {
      ...b,
      version: cur ? cur.version + 1 : 1,
    };
    this.balances.set(key, next);
    return next;
  }

  getBalances(input: {
    hcmEmployeeId: string;
    hcmLocationId: string;
  }): Promise<HcmBalance[]> {
    if (this.failures.getBalancesTransient) {
      return Promise.reject(
        new HcmTransientError('mock HCM 503 on getBalances'),
      );
    }
    const out: HcmBalance[] = [];
    for (const b of this.balances.values()) {
      if (
        b.hcmEmployeeId === input.hcmEmployeeId &&
        b.hcmLocationId === input.hcmLocationId
      ) {
        out.push(this.toExternal(b));
      }
    }
    return Promise.resolve(out);
  }

  listAllBalances(input: {
    cursor?: string | null;
  }): Promise<{ items: HcmBalance[]; nextCursor: string | null }> {
    if (this.failures.listAllTransient) {
      return Promise.reject(
        new HcmTransientError('mock HCM 503 on listAllBalances'),
      );
    }
    const PAGE_SIZE = 50;
    const all = Array.from(this.balances.values()).map((b) =>
      this.toExternal(b),
    );
    const offset = input.cursor ? parseInt(input.cursor, 10) : 0;
    const slice = all.slice(offset, offset + PAGE_SIZE);
    const nextCursor =
      offset + PAGE_SIZE < all.length ? String(offset + PAGE_SIZE) : null;
    return Promise.resolve({ items: slice, nextCursor });
  }

  fileTimeOff(input: HcmFileRequest): Promise<HcmFileResponse> {
    if (this.failures.fileTimeOffPermanent) {
      return Promise.reject(
        new HcmPermanentError('mock HCM 400 on fileTimeOff'),
      );
    }
    if (this.failures.fileTimeOffTransientUntil > 0) {
      this.failures.fileTimeOffTransientUntil -= 1;
      return Promise.reject(
        new HcmTransientError('mock HCM 503 on fileTimeOff'),
      );
    }
    const idemKey = `file:${input.requestId}`;
    const existing = this.idempotency.get(idemKey);
    if (existing) {
      return Promise.resolve({ hcmRequestId: existing.hcmRequestId });
    }
    const key = this.k(input);
    const bal = this.balances.get(key);
    if (!bal) {
      return Promise.reject(
        new HcmPermanentError(
          `mock HCM: no balance for ${input.hcmEmployeeId}/${input.hcmLocationId}/${input.leaveType}`,
        ),
      );
    }
    if (bal.balanceMinutes < input.durationMinutes) {
      return Promise.reject(
        new HcmPermanentError(
          `mock HCM: insufficient balance ${bal.balanceMinutes} < ${input.durationMinutes}`,
        ),
      );
    }
    bal.balanceMinutes -= input.durationMinutes;
    bal.version += 1;
    const hcmRequestId = `hcm-req-${this.nextHcmRequestSeq++}`;
    const filed: FiledRequest = {
      hcmRequestId,
      hcmEmployeeId: input.hcmEmployeeId,
      hcmLocationId: input.hcmLocationId,
      leaveType: input.leaveType,
      durationMinutes: input.durationMinutes,
      cancelled: false,
    };
    this.filed.set(hcmRequestId, filed);
    this.idempotency.set(idemKey, filed);
    return Promise.resolve({ hcmRequestId });
  }

  cancelTimeOff(input: { hcmRequestId: string }): Promise<void> {
    const f = this.filed.get(input.hcmRequestId);
    if (!f) {
      return Promise.reject(
        new HcmPermanentError(
          `mock HCM: unknown request ${input.hcmRequestId}`,
        ),
      );
    }
    if (f.cancelled) return Promise.resolve();
    const key = this.k(f);
    const bal = this.balances.get(key);
    if (bal) {
      bal.balanceMinutes += f.durationMinutes;
      bal.version += 1;
    }
    f.cancelled = true;
    return Promise.resolve();
  }

  private k(b: MockBalanceKey): string {
    return `${b.hcmEmployeeId}|${b.hcmLocationId}|${b.leaveType}`;
  }

  private toExternal(b: MockBalance): HcmBalance {
    return {
      hcmEmployeeId: b.hcmEmployeeId,
      hcmLocationId: b.hcmLocationId,
      leaveType: b.leaveType,
      balanceMinutes: b.balanceMinutes,
      version: `v${b.version}`,
    };
  }
}
