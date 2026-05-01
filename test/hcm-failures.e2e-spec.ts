import { E2eHarness, seed, startE2e } from './utils';

describe('HCM failures (e2e)', () => {
  let h: E2eHarness;

  beforeEach(async () => {
    h = await startE2e();
  });

  afterEach(async () => {
    await h.close();
  });

  it('approval succeeds eventually after HCM file outage', async () => {
    const s = seed(h, { vacationMinutes: 4800 });
    const r = h.timeOff.create({
      employeeId: s.employeeId,
      locationId: s.locationId,
      leaveType: 'VACATION',
      startDate: '2026-06-10',
      endDate: '2026-06-10',
      durationMinutes: 480,
    });
    await h.timeOff.approve(r.id, 'mgr-1');

    h.hcm.failures.fileTimeOffTransientUntil = 3;
    let attempts = 0;
    let succeeded = false;
    for (let i = 0; i < 8 && !succeeded; i++) {
      h.clock.setForTests(new Date(Date.now() + (i + 1) * 24 * 3600_000));
      const f = await h.outbox.flushOnce();
      attempts += f.processed;
      if (f.succeeded > 0) succeeded = true;
    }
    expect(succeeded).toBe(true);
    expect(attempts).toBeGreaterThanOrEqual(4);
    const view = h.balances.view(s.employeeId, s.locationId, 'VACATION')!;
    expect(view.hcmBalanceMinutes).toBe(4320);
    expect(view.reservedMinutes).toBe(0);
  });

  it('permanent HCM error releases reservation and FAILs request', async () => {
    const s = seed(h, { vacationMinutes: 4800 });
    const r = h.timeOff.create({
      employeeId: s.employeeId,
      locationId: s.locationId,
      leaveType: 'VACATION',
      startDate: '2026-06-10',
      endDate: '2026-06-10',
      durationMinutes: 480,
    });
    await h.timeOff.approve(r.id, 'mgr-1');
    h.hcm.failures.fileTimeOffPermanent = true;
    const f = await h.outbox.flushOnce();
    expect(f.dead).toBe(1);
    expect(h.timeOff.get(r.id)!.status).toBe('FAILED');
    const view = h.balances.view(s.employeeId, s.locationId, 'VACATION')!;
    expect(view.reservedMinutes).toBe(0);
    expect(view.hcmBalanceMinutes).toBe(4800);
  });

  it('approval blocks with 503 when HCM realtime is down (transient)', async () => {
    const s = seed(h, { vacationMinutes: 4800 });
    const r = h.timeOff.create({
      employeeId: s.employeeId,
      locationId: s.locationId,
      leaveType: 'VACATION',
      startDate: '2026-06-10',
      endDate: '2026-06-10',
      durationMinutes: 480,
    });
    h.hcm.failures.getBalancesTransient = true;
    await expect(h.timeOff.approve(r.id, 'mgr-1')).rejects.toThrow();
    // Reservation unchanged: caller can retry once HCM recovers.
    const view = h.balances.view(s.employeeId, s.locationId, 'VACATION')!;
    expect(view.reservedMinutes).toBe(480);
    h.hcm.failures.getBalancesTransient = false;
    await h.timeOff.approve(r.id, 'mgr-1');
    expect(h.timeOff.get(r.id)!.status).toBe('APPROVED');
  });
});
