import { buildTestHarness, seedEmployee, TestHarness } from '../test-utils';

describe('SyncService', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await buildTestHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it('webhook updates hcm balance and preserves reservations', () => {
    const seed = seedEmployee(h, { vacationMinutes: 4800 });
    h.db.transaction((db) => {
      h.balances.reserveTx(
        db,
        seed.employeeId,
        seed.locationId,
        'VACATION',
        480,
        { cause: 'REQUEST_CREATED' },
      );
    });

    const result = h.sync.applyWebhook({
      hcmEmployeeId: seed.hcmEmployeeId,
      hcmLocationId: seed.hcmLocationId,
      leaveType: 'VACATION',
      balanceMinutes: 7680,
      version: 'etag-1',
    });
    expect(result.applied).toBe(true);

    const view = h.balances.view(seed.employeeId, seed.locationId, 'VACATION')!;
    expect(view.hcmBalanceMinutes).toBe(7680);
    expect(view.reservedMinutes).toBe(480);
  });

  it('webhook is idempotent on (employee,location,type,version,occurredAt)', () => {
    const seed = seedEmployee(h);
    const r1 = h.sync.applyWebhook({
      hcmEmployeeId: seed.hcmEmployeeId,
      hcmLocationId: seed.hcmLocationId,
      leaveType: 'VACATION',
      balanceMinutes: 9999,
      version: 'v1',
      occurredAt: '2026-04-30T15:00:00.000Z',
    });
    const r2 = h.sync.applyWebhook({
      hcmEmployeeId: seed.hcmEmployeeId,
      hcmLocationId: seed.hcmLocationId,
      leaveType: 'VACATION',
      balanceMinutes: 9999,
      version: 'v1',
      occurredAt: '2026-04-30T15:00:00.000Z',
    });
    expect(r1.applied).toBe(true);
    expect(r2.applied).toBe(false);
    expect(r2.reason).toBe('duplicate-event');
  });

  it('webhook is ignored for unknown employee/location', () => {
    const r = h.sync.applyWebhook({
      hcmEmployeeId: 'does-not-exist',
      hcmLocationId: 'does-not-exist',
      leaveType: 'VACATION',
      balanceMinutes: 480,
    });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('unknown-employee-or-location');
  });

  it('full sync repairs drift without touching reservations', async () => {
    const seed = seedEmployee(h, { vacationMinutes: 4800 });
    h.db.transaction((db) => {
      h.balances.reserveTx(
        db,
        seed.employeeId,
        seed.locationId,
        'VACATION',
        480,
        { cause: 'REQUEST_CREATED' },
      );
    });
    h.hcm.setBalance({
      hcmEmployeeId: seed.hcmEmployeeId,
      hcmLocationId: seed.hcmLocationId,
      leaveType: 'VACATION',
      balanceMinutes: 9000,
    });
    const r = await h.sync.fullSync();
    expect(r.scanned).toBeGreaterThan(0);
    expect(r.updated + r.unchanged + r.newBalances).toBe(r.scanned);

    const view = h.balances.view(seed.employeeId, seed.locationId, 'VACATION')!;
    expect(view.hcmBalanceMinutes).toBe(9000);
    expect(view.reservedMinutes).toBe(480);
  });

  it('full sync creates new employees/locations from HCM', async () => {
    h.hcm.seedBalance({
      hcmEmployeeId: 'new-emp',
      hcmLocationId: 'new-loc',
      leaveType: 'PERSONAL',
      balanceMinutes: 1440,
    });
    const r = await h.sync.fullSync();
    expect(r.newEmployees).toBeGreaterThanOrEqual(1);
    expect(r.newLocations).toBeGreaterThanOrEqual(1);
    expect(h.employees.findByHcmId('new-emp')).not.toBeNull();
    expect(h.employees.findLocationByHcmId('new-loc')).not.toBeNull();
  });

  it('reconcileEmployee touches only that employee', async () => {
    const a = seedEmployee(h, {
      employeeId: 'emp-a',
      hcmEmployeeId: 'wd-a',
    });
    const b = seedEmployee(h, {
      employeeId: 'emp-b',
      hcmEmployeeId: 'wd-b',
    });
    h.hcm.setBalance({
      hcmEmployeeId: a.hcmEmployeeId,
      hcmLocationId: a.hcmLocationId,
      leaveType: 'VACATION',
      balanceMinutes: 9999,
    });
    h.hcm.setBalance({
      hcmEmployeeId: b.hcmEmployeeId,
      hcmLocationId: b.hcmLocationId,
      leaveType: 'VACATION',
      balanceMinutes: 1111,
    });
    await h.sync.reconcileEmployee(a.employeeId);
    expect(
      h.balances.view(a.employeeId, a.locationId, 'VACATION')!
        .hcmBalanceMinutes,
    ).toBe(9999);
    expect(
      h.balances.view(b.employeeId, b.locationId, 'VACATION')!
        .hcmBalanceMinutes,
    ).toBe(
      4800, // untouched
    );
  });
});
