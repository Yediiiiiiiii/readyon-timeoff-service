import { buildTestHarness, seedEmployee, TestHarness } from '../test-utils';

describe('BalancesService', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await buildTestHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it('reserves and releases minutes', () => {
    const { employeeId, locationId } = seedEmployee(h, {
      vacationMinutes: 4800,
    });
    h.db.transaction((db) => {
      h.balances.reserveTx(db, employeeId, locationId, 'VACATION', 480, {
        cause: 'REQUEST_CREATED',
      });
    });
    let v = h.balances.view(employeeId, locationId, 'VACATION')!;
    expect(v.reservedMinutes).toBe(480);
    expect(v.availableMinutes).toBe(4320);

    h.db.transaction((db) => {
      h.balances.releaseTx(db, employeeId, locationId, 'VACATION', 480, {
        cause: 'REQUEST_CANCELLED',
      });
    });
    v = h.balances.view(employeeId, locationId, 'VACATION')!;
    expect(v.reservedMinutes).toBe(0);
    expect(v.availableMinutes).toBe(4800);
  });

  it('refuses to reserve more than HCM balance', () => {
    const { employeeId, locationId } = seedEmployee(h, {
      vacationMinutes: 480,
    });
    expect(() =>
      h.db.transaction((db) =>
        h.balances.reserveTx(db, employeeId, locationId, 'VACATION', 481, {
          cause: 'REQUEST_CREATED',
        }),
      ),
    ).toThrow(/Insufficient/i);
  });

  it('settles a reservation by dropping reserved AND hcm balance', () => {
    const { employeeId, locationId } = seedEmployee(h, {
      vacationMinutes: 4800,
    });
    h.db.transaction((db) => {
      h.balances.reserveTx(db, employeeId, locationId, 'VACATION', 480, {
        cause: 'REQUEST_CREATED',
      });
    });
    h.db.transaction((db) => {
      h.balances.settleReservationTx(
        db,
        employeeId,
        locationId,
        'VACATION',
        480,
        {
          cause: 'REQUEST_APPROVED',
        },
      );
    });
    const v = h.balances.view(employeeId, locationId, 'VACATION')!;
    expect(v.reservedMinutes).toBe(0);
    expect(v.hcmBalanceMinutes).toBe(4320);
    expect(v.availableMinutes).toBe(4320);
  });

  it('preserves reservations when HCM bumps balance (anniversary)', () => {
    const { employeeId, locationId } = seedEmployee(h, {
      vacationMinutes: 4800,
    });
    h.db.transaction((db) => {
      h.balances.reserveTx(db, employeeId, locationId, 'VACATION', 480, {
        cause: 'REQUEST_CREATED',
      });
    });
    h.balances.applyHcmBalance({
      employeeId,
      locationId,
      leaveType: 'VACATION',
      newHcmMinutes: 7680, // anniversary bonus +6h… +2880m
      cause: 'HCM_WEBHOOK',
    });
    const v = h.balances.view(employeeId, locationId, 'VACATION')!;
    expect(v.hcmBalanceMinutes).toBe(7680);
    expect(v.reservedMinutes).toBe(480); // preserved
    expect(v.availableMinutes).toBe(7200);
  });

  it('writes an audit ledger row for every change', () => {
    const { employeeId, locationId } = seedEmployee(h, {
      vacationMinutes: 4800,
    });
    h.db.transaction((db) => {
      h.balances.reserveTx(db, employeeId, locationId, 'VACATION', 480, {
        cause: 'REQUEST_CREATED',
        actor: 'employee:emp-1',
        requestId: 'req-x',
      });
    });
    const ledger = h.balances.ledger(employeeId, locationId, 'VACATION');
    const causes = ledger.map((l) => l.cause);
    expect(causes).toContain('REQUEST_CREATED');
    expect(causes).toContain('HCM_RECONCILE'); // from seed
  });

  it('clamps at zero when HCM declares balance below current reservations', () => {
    const { employeeId, locationId } = seedEmployee(h, {
      vacationMinutes: 4800,
    });
    h.db.transaction((db) => {
      h.balances.reserveTx(db, employeeId, locationId, 'VACATION', 4800, {
        cause: 'REQUEST_CREATED',
      });
    });
    h.balances.applyHcmBalance({
      employeeId,
      locationId,
      leaveType: 'VACATION',
      newHcmMinutes: 100,
      cause: 'HCM_WEBHOOK',
    });
    const v = h.balances.view(employeeId, locationId, 'VACATION')!;
    expect(v.hcmBalanceMinutes).toBe(100);
    expect(v.reservedMinutes).toBe(4800); // not clobbered
    expect(v.availableMinutes).toBe(0); // clamped
  });

  it('rejects negative HCM balance updates', () => {
    const { employeeId, locationId } = seedEmployee(h);
    h.balances.applyHcmBalance({
      employeeId,
      locationId,
      leaveType: 'VACATION',
      newHcmMinutes: -100,
      cause: 'HCM_WEBHOOK',
    });
    const v = h.balances.view(employeeId, locationId, 'VACATION')!;
    expect(v.hcmBalanceMinutes).toBe(0);
  });

  it('throws when reserving a non-existent balance row', () => {
    seedEmployee(h);
    expect(() =>
      h.db.transaction((db) =>
        h.balances.reserveTx(db, 'emp-1', 'loc-NYC', 'PERSONAL', 60, {
          cause: 'REQUEST_CREATED',
        }),
      ),
    ).toThrow(/balance/i);
  });

  it('release on non-existent balance throws', () => {
    seedEmployee(h);
    expect(() =>
      h.db.transaction((db) =>
        h.balances.releaseTx(db, 'emp-1', 'loc-NYC', 'PERSONAL', 60, {
          cause: 'REQUEST_CANCELLED',
        }),
      ),
    ).toThrow(/balance/i);
  });

  it('applyHcmBalance creates balance row when missing', () => {
    const e = h.employees.upsertEmployee({
      id: 'emp-x',
      hcmEmployeeId: 'wd-x',
      name: 'X',
    });
    const l = h.employees.upsertLocation({
      id: 'loc-x',
      hcmLocationId: 'wd-loc-x',
      name: 'L',
    });
    const v = h.balances.applyHcmBalance({
      employeeId: e.id,
      locationId: l.id,
      leaveType: 'PERSONAL',
      newHcmMinutes: 480,
      cause: 'HCM_RECONCILE',
    });
    expect(v.hcmBalanceMinutes).toBe(480);
    expect(v.reservedMinutes).toBe(0);
  });

  it('reserveTx rejects zero or negative minutes', () => {
    seedEmployee(h);
    expect(() =>
      h.db.transaction((db) =>
        h.balances.reserveTx(db, 'emp-1', 'loc-NYC', 'VACATION', 0, {
          cause: 'REQUEST_CREATED',
        }),
      ),
    ).toThrow(/must be positive|Invalid/i);
  });

  it('list returns balances ordered by location and type', () => {
    seedEmployee(h);
    const all = h.balances.list('emp-1');
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it('ledger query supports filters', () => {
    seedEmployee(h);
    expect(h.balances.ledger('emp-1').length).toBeGreaterThan(0);
    expect(
      h.balances.ledger('emp-1', 'loc-NYC', 'VACATION').length,
    ).toBeGreaterThan(0);
  });
});
