import { buildTestHarness, TestHarness } from '../test-utils';
import { HcmPermanentError, HcmTransientError } from './hcm-client';

describe('MockHcmService', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await buildTestHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it('returns seeded balances and paginates', async () => {
    for (let i = 0; i < 75; i++) {
      h.hcm.seedBalance({
        hcmEmployeeId: `wd-${i}`,
        hcmLocationId: 'loc',
        leaveType: 'VACATION',
        balanceMinutes: 480,
      });
    }
    const page1 = await h.hcm.listAllBalances({ cursor: null });
    expect(page1.items.length).toBe(50);
    expect(page1.nextCursor).toBe('50');
    const page2 = await h.hcm.listAllBalances({ cursor: page1.nextCursor });
    expect(page2.items.length).toBe(25);
    expect(page2.nextCursor).toBeNull();
  });

  it('files a time-off and decrements balance idempotently', async () => {
    h.hcm.seedBalance({
      hcmEmployeeId: 'wd-1',
      hcmLocationId: 'loc',
      leaveType: 'VACATION',
      balanceMinutes: 480,
    });
    const r1 = await h.hcm.fileTimeOff({
      requestId: 'req-1',
      hcmEmployeeId: 'wd-1',
      hcmLocationId: 'loc',
      leaveType: 'VACATION',
      startDate: '2026-06-01',
      endDate: '2026-06-01',
      durationMinutes: 240,
    });
    const r2 = await h.hcm.fileTimeOff({
      requestId: 'req-1',
      hcmEmployeeId: 'wd-1',
      hcmLocationId: 'loc',
      leaveType: 'VACATION',
      startDate: '2026-06-01',
      endDate: '2026-06-01',
      durationMinutes: 240,
    });
    expect(r1.hcmRequestId).toBe(r2.hcmRequestId);
    const balances = await h.hcm.getBalances({
      hcmEmployeeId: 'wd-1',
      hcmLocationId: 'loc',
    });
    expect(balances[0].balanceMinutes).toBe(240);
  });

  it('throws transient error N times then succeeds', async () => {
    h.hcm.seedBalance({
      hcmEmployeeId: 'wd-1',
      hcmLocationId: 'loc',
      leaveType: 'VACATION',
      balanceMinutes: 480,
    });
    h.hcm.failures.fileTimeOffTransientUntil = 2;
    await expect(
      h.hcm.fileTimeOff({
        requestId: 'req-2',
        hcmEmployeeId: 'wd-1',
        hcmLocationId: 'loc',
        leaveType: 'VACATION',
        startDate: '2026-06-01',
        endDate: '2026-06-01',
        durationMinutes: 60,
      }),
    ).rejects.toBeInstanceOf(HcmTransientError);
    await expect(
      h.hcm.fileTimeOff({
        requestId: 'req-2',
        hcmEmployeeId: 'wd-1',
        hcmLocationId: 'loc',
        leaveType: 'VACATION',
        startDate: '2026-06-01',
        endDate: '2026-06-01',
        durationMinutes: 60,
      }),
    ).rejects.toBeInstanceOf(HcmTransientError);
    const ok = await h.hcm.fileTimeOff({
      requestId: 'req-2',
      hcmEmployeeId: 'wd-1',
      hcmLocationId: 'loc',
      leaveType: 'VACATION',
      startDate: '2026-06-01',
      endDate: '2026-06-01',
      durationMinutes: 60,
    });
    expect(ok.hcmRequestId).toMatch(/^hcm-req-/);
  });

  it('rejects when HCM has insufficient balance', async () => {
    h.hcm.seedBalance({
      hcmEmployeeId: 'wd-1',
      hcmLocationId: 'loc',
      leaveType: 'VACATION',
      balanceMinutes: 100,
    });
    await expect(
      h.hcm.fileTimeOff({
        requestId: 'req-3',
        hcmEmployeeId: 'wd-1',
        hcmLocationId: 'loc',
        leaveType: 'VACATION',
        startDate: '2026-06-01',
        endDate: '2026-06-01',
        durationMinutes: 200,
      }),
    ).rejects.toBeInstanceOf(HcmPermanentError);
  });

  it('cancels a filed request and refunds the balance', async () => {
    h.hcm.seedBalance({
      hcmEmployeeId: 'wd-1',
      hcmLocationId: 'loc',
      leaveType: 'VACATION',
      balanceMinutes: 480,
    });
    const filed = await h.hcm.fileTimeOff({
      requestId: 'req-4',
      hcmEmployeeId: 'wd-1',
      hcmLocationId: 'loc',
      leaveType: 'VACATION',
      startDate: '2026-06-01',
      endDate: '2026-06-01',
      durationMinutes: 240,
    });
    await h.hcm.cancelTimeOff({ hcmRequestId: filed.hcmRequestId });
    await h.hcm.cancelTimeOff({ hcmRequestId: filed.hcmRequestId }); // idempotent
    const balances = await h.hcm.getBalances({
      hcmEmployeeId: 'wd-1',
      hcmLocationId: 'loc',
    });
    expect(balances[0].balanceMinutes).toBe(480);
  });

  it('bumpBalance simulates an anniversary refresh', () => {
    h.hcm.seedBalance({
      hcmEmployeeId: 'wd-1',
      hcmLocationId: 'loc',
      leaveType: 'VACATION',
      balanceMinutes: 480,
    });
    h.hcm.bumpBalance(
      { hcmEmployeeId: 'wd-1', hcmLocationId: 'loc', leaveType: 'VACATION' },
      2400,
    );
    const cur = h.hcm.bumpBalance(
      { hcmEmployeeId: 'wd-1', hcmLocationId: 'loc', leaveType: 'VACATION' },
      0,
    );
    expect(cur.balanceMinutes).toBe(2880);
  });

  it('bumpBalance creates missing row on demand', () => {
    const cur = h.hcm.bumpBalance(
      { hcmEmployeeId: 'wd-9', hcmLocationId: 'loc', leaveType: 'VACATION' },
      720,
    );
    expect(cur.balanceMinutes).toBe(720);
  });

  it('throws transient on getBalances when configured', async () => {
    h.hcm.failures.getBalancesTransient = true;
    await expect(
      h.hcm.getBalances({ hcmEmployeeId: 'wd-1', hcmLocationId: 'loc' }),
    ).rejects.toThrow(/503/);
  });

  it('throws transient on listAllBalances when configured', async () => {
    h.hcm.failures.listAllTransient = true;
    await expect(h.hcm.listAllBalances({ cursor: null })).rejects.toThrow(
      /503/,
    );
  });

  it('cancelTimeOff on unknown id throws permanent', async () => {
    await expect(h.hcm.cancelTimeOff({ hcmRequestId: 'nope' })).rejects.toThrow(
      /unknown request/,
    );
  });

  it('fileTimeOff on unknown balance throws permanent', async () => {
    await expect(
      h.hcm.fileTimeOff({
        requestId: 'r-a',
        hcmEmployeeId: 'unknown',
        hcmLocationId: 'unknown',
        leaveType: 'VACATION',
        startDate: '2026-06-01',
        endDate: '2026-06-01',
        durationMinutes: 60,
      }),
    ).rejects.toThrow(/no balance/i);
  });

  it('fileTimeOff with permanent failure flag throws', async () => {
    h.hcm.seedBalance({
      hcmEmployeeId: 'wd-1',
      hcmLocationId: 'loc',
      leaveType: 'VACATION',
      balanceMinutes: 480,
    });
    h.hcm.failures.fileTimeOffPermanent = true;
    await expect(
      h.hcm.fileTimeOff({
        requestId: 'r-perm',
        hcmEmployeeId: 'wd-1',
        hcmLocationId: 'loc',
        leaveType: 'VACATION',
        startDate: '2026-06-01',
        endDate: '2026-06-01',
        durationMinutes: 60,
      }),
    ).rejects.toThrow(/400/);
  });

  it('reset clears state and failures', () => {
    h.hcm.seedBalance({
      hcmEmployeeId: 'wd-1',
      hcmLocationId: 'loc',
      leaveType: 'VACATION',
      balanceMinutes: 480,
    });
    h.hcm.failures.fileTimeOffPermanent = true;
    h.hcm.reset();
    expect(h.hcm.failures.fileTimeOffPermanent).toBe(false);
  });
});
