import { buildTestHarness, seedEmployee, TestHarness } from '../test-utils';
import { MAX_OUTBOX_ATTEMPTS } from './outbox.service';

describe('OutboxService', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await buildTestHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it('retries transient failures and eventually succeeds', async () => {
    const { employeeId, locationId } = seedEmployee(h, {
      vacationMinutes: 4800,
    });
    const r = h.timeOff.create({
      employeeId,
      locationId,
      leaveType: 'VACATION',
      startDate: '2026-06-10',
      endDate: '2026-06-10',
      durationMinutes: 480,
    });
    await h.timeOff.approve(r.id, 'mgr-7');
    h.hcm.failures.fileTimeOffTransientUntil = 2;

    const f1 = await h.outbox.flushOnce();
    expect(f1.retried).toBe(1);
    // Move clock forward so retry-time elapses.
    h.clock.setForTests(new Date(Date.now() + 60_000));
    const f2 = await h.outbox.flushOnce();
    expect(f2.retried).toBe(1);
    h.clock.setForTests(new Date(Date.now() + 120_000));
    const f3 = await h.outbox.flushOnce();
    expect(f3.succeeded).toBe(1);
    expect(h.timeOff.get(r.id)!.status).toBe('APPROVED');
    expect(h.timeOff.get(r.id)!.hcmRequestId).toMatch(/^hcm-req-/);
  });

  it('marks DEAD after max attempts and FAILS the request', async () => {
    const { employeeId, locationId } = seedEmployee(h, {
      vacationMinutes: 4800,
    });
    const r = h.timeOff.create({
      employeeId,
      locationId,
      leaveType: 'VACATION',
      startDate: '2026-06-10',
      endDate: '2026-06-10',
      durationMinutes: 480,
    });
    await h.timeOff.approve(r.id, 'mgr-7');
    h.hcm.failures.fileTimeOffTransientUntil = 999;

    for (let i = 0; i < MAX_OUTBOX_ATTEMPTS; i++) {
      h.clock.setForTests(new Date(Date.now() + (i + 1) * 24 * 3600_000));
      await h.outbox.flushOnce();
    }
    const rows = h.outbox.byRequestId(r.id);
    expect(rows[0].status).toBe('DEAD');
    expect(h.timeOff.get(r.id)!.status).toBe('FAILED');
    const view = h.balances.view(employeeId, locationId, 'VACATION')!;
    expect(view.reservedMinutes).toBe(0);
  });

  it('does nothing when there is nothing pending', async () => {
    const f = await h.outbox.flushOnce();
    expect(f.processed).toBe(0);
  });
});
