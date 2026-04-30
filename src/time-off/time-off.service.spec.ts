import { buildTestHarness, seedEmployee, TestHarness } from '../test-utils';

describe('TimeOffService', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await buildTestHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it('happy path: create -> approve -> file flushed -> balance settled', async () => {
    const { employeeId, locationId } = seedEmployee(h, {
      vacationMinutes: 4800,
    });
    const created = h.timeOff.create({
      employeeId,
      locationId,
      leaveType: 'VACATION',
      startDate: '2026-06-10',
      endDate: '2026-06-10',
      durationMinutes: 480,
    });
    expect(created.status).toBe('PENDING');
    let view = h.balances.view(employeeId, locationId, 'VACATION')!;
    expect(view.reservedMinutes).toBe(480);
    expect(view.availableMinutes).toBe(4320);

    await h.timeOff.approve(created.id, 'mgr-7');
    expect(h.timeOff.get(created.id)!.status).toBe('APPROVED');
    // Reservation still held until outbox flushes.
    view = h.balances.view(employeeId, locationId, 'VACATION')!;
    expect(view.reservedMinutes).toBe(480);
    expect(view.hcmBalanceMinutes).toBe(4800);

    const flush = await h.outbox.flushOnce();
    expect(flush.succeeded).toBe(1);

    view = h.balances.view(employeeId, locationId, 'VACATION')!;
    expect(view.reservedMinutes).toBe(0);
    expect(view.hcmBalanceMinutes).toBe(4320);
    expect(h.timeOff.get(created.id)!.hcmRequestId).toMatch(/^hcm-req-/);
  });

  it('cancel of PENDING releases reservation', () => {
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
    return h.timeOff.cancel(r.id).then(() => {
      const view = h.balances.view(employeeId, locationId, 'VACATION')!;
      expect(view.reservedMinutes).toBe(0);
      expect(view.availableMinutes).toBe(4800);
      expect(h.timeOff.get(r.id)!.status).toBe('CANCELLED');
    });
  });

  it('cancel of APPROVED-not-yet-filed kills outbox row and releases', async () => {
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
    // Don't flush — cancel before HCM sees the file.
    await h.timeOff.cancel(r.id);
    expect(h.timeOff.get(r.id)!.status).toBe('CANCELLED');
    const view = h.balances.view(employeeId, locationId, 'VACATION')!;
    expect(view.reservedMinutes).toBe(0);
    // Flushing should now no-op the dead outbox row.
    const flush = await h.outbox.flushOnce();
    expect(flush.processed).toBe(0);
  });

  it('cancel of APPROVED-and-filed enqueues HCM cancel', async () => {
    const { employeeId, locationId, hcmEmployeeId, hcmLocationId } =
      seedEmployee(h, { vacationMinutes: 4800 });
    const r = h.timeOff.create({
      employeeId,
      locationId,
      leaveType: 'VACATION',
      startDate: '2026-06-10',
      endDate: '2026-06-10',
      durationMinutes: 480,
    });
    await h.timeOff.approve(r.id, 'mgr-7');
    await h.outbox.flushOnce();

    await h.timeOff.cancel(r.id);
    expect(h.timeOff.get(r.id)!.status).toBe('CANCELLED');
    // The HCM cancel is enqueued. Flush it.
    const flush = await h.outbox.flushOnce();
    expect(flush.succeeded).toBe(1);
    const balances = await h.hcm.getBalances({
      hcmEmployeeId,
      hcmLocationId,
    });
    const vac = balances.find((b) => b.leaveType === 'VACATION')!;
    expect(vac.balanceMinutes).toBe(4800);
    const view = h.balances.view(employeeId, locationId, 'VACATION')!;
    expect(view.hcmBalanceMinutes).toBe(4800);
  });

  it('rejects a request that exceeds available balance', () => {
    const { employeeId, locationId } = seedEmployee(h, {
      vacationMinutes: 480,
    });
    expect(() =>
      h.timeOff.create({
        employeeId,
        locationId,
        leaveType: 'VACATION',
        startDate: '2026-06-10',
        endDate: '2026-06-10',
        durationMinutes: 481,
      }),
    ).toThrow(/Insufficient/i);
  });

  it('approve fails fast if HCM is unavailable (transient)', async () => {
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
    h.hcm.failures.getBalancesTransient = true;
    await expect(h.timeOff.approve(r.id, 'mgr-7')).rejects.toThrow(
      /HCM_UNAVAILABLE|HCM unavailable/i,
    );
    // Reservation untouched — caller can retry.
    expect(
      h.balances.view(employeeId, locationId, 'VACATION')!.reservedMinutes,
    ).toBe(480);
    expect(h.timeOff.get(r.id)!.status).toBe('PENDING');
  });

  it('approve detects HCM disagreement and FAILs the request', async () => {
    const { employeeId, locationId, hcmEmployeeId, hcmLocationId } =
      seedEmployee(h, { vacationMinutes: 4800 });
    const r = h.timeOff.create({
      employeeId,
      locationId,
      leaveType: 'VACATION',
      startDate: '2026-06-10',
      endDate: '2026-06-10',
      durationMinutes: 480,
    });
    // HR drops the balance to zero behind our back.
    h.hcm.setBalance({
      hcmEmployeeId,
      hcmLocationId,
      leaveType: 'VACATION',
      balanceMinutes: 0,
    });
    await expect(h.timeOff.approve(r.id, 'mgr-7')).rejects.toThrow(
      /Insufficient/i,
    );
    expect(h.timeOff.get(r.id)!.status).toBe('FAILED');
    const view = h.balances.view(employeeId, locationId, 'VACATION')!;
    expect(view.reservedMinutes).toBe(0);
    expect(view.hcmBalanceMinutes).toBe(0);
  });

  it('outbox file with permanent HCM error fails the request and releases', async () => {
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
    h.hcm.failures.fileTimeOffPermanent = true;
    const flush = await h.outbox.flushOnce();
    expect(flush.dead).toBe(1);
    expect(h.timeOff.get(r.id)!.status).toBe('FAILED');
    const view = h.balances.view(employeeId, locationId, 'VACATION')!;
    expect(view.reservedMinutes).toBe(0);
    expect(view.hcmBalanceMinutes).toBe(4800);
  });

  it('rejects illegal transitions', async () => {
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
    await expect(h.timeOff.approve(r.id, 'mgr-7')).rejects.toThrow(/Illegal/i);
  });

  it('rejects invalid date range', () => {
    const { employeeId, locationId } = seedEmployee(h);
    expect(() =>
      h.timeOff.create({
        employeeId,
        locationId,
        leaveType: 'VACATION',
        startDate: '2026-06-12',
        endDate: '2026-06-10',
        durationMinutes: 480,
      }),
    ).toThrow(/startDate/i);
  });
});
