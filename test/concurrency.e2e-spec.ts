import { DomainError } from '../src/common/errors';
import { E2eHarness, seed, startE2e } from './utils';

describe('Concurrency (e2e)', () => {
  let h: E2eHarness;

  beforeEach(async () => {
    h = await startE2e();
  });

  afterEach(async () => {
    await h.close();
  });

  /**
   * Critical safety test: 100 concurrent requests for a 50-minute balance,
   * each asking for 1 minute. Exactly 50 should succeed.
   */
  it('rejects double-spend under concurrency', async () => {
    const s = seed(h, { vacationMinutes: 50 });
    const promises = Array.from({ length: 100 }, () =>
      Promise.resolve().then(() =>
        h.timeOff.create({
          employeeId: s.employeeId,
          locationId: s.locationId,
          leaveType: 'VACATION',
          startDate: '2026-06-10',
          endDate: '2026-06-10',
          durationMinutes: 1,
        }),
      ),
    );
    const results = await Promise.allSettled(promises);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const fail = results.filter((r) => r.status === 'rejected');
    expect(ok).toBe(50);
    expect(fail.length).toBe(50);
    for (const f of fail) {
      const reason = f.reason;
      expect(
        reason instanceof DomainError &&
          (reason.code === 'INSUFFICIENT_BALANCE' ||
            reason.code === 'CONCURRENCY_CONFLICT'),
      ).toBe(true);
    }
    const view = h.balances.view(s.employeeId, s.locationId, 'VACATION')!;
    expect(view.reservedMinutes).toBe(50);
    expect(view.availableMinutes).toBe(0);
    expect(view.hcmBalanceMinutes).toBe(50);
  });

  it('total committed never exceeds HCM balance under bursty load', async () => {
    const s = seed(h, { vacationMinutes: 30 });
    const promises = Array.from({ length: 60 }, () =>
      Promise.resolve().then(() =>
        h.timeOff.create({
          employeeId: s.employeeId,
          locationId: s.locationId,
          leaveType: 'VACATION',
          startDate: '2026-06-10',
          endDate: '2026-06-10',
          durationMinutes: 5,
        }),
      ),
    );
    const results = await Promise.allSettled(promises);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBe(6); // 6×5 = 30
    const view = h.balances.view(s.employeeId, s.locationId, 'VACATION')!;
    expect(view.reservedMinutes).toBeLessThanOrEqual(30);
  });
});
