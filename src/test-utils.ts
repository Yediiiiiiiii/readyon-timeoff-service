import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './app.module';
import { DbService } from './db/db.service';
import { EmployeesService } from './employees/employees.service';
import { BalancesService } from './balances/balances.service';
import { MockHcmService } from './hcm/mock-hcm.service';
import { TimeOffService } from './time-off/time-off.service';
import { OutboxService } from './sync/outbox.service';
import { SyncService } from './sync/sync.service';
import { Clock } from './common/clock';

process.env.DISABLE_SCHEDULER = '1';
process.env.DB_PATH = ':memory:';

export interface TestHarness {
  module: TestingModule;
  db: DbService;
  clock: Clock;
  employees: EmployeesService;
  balances: BalancesService;
  hcm: MockHcmService;
  timeOff: TimeOffService;
  outbox: OutboxService;
  sync: SyncService;
  close: () => Promise<void>;
}

export async function buildTestHarness(): Promise<TestHarness> {
  const module = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  await module.init();
  return {
    module,
    db: module.get(DbService),
    clock: module.get(Clock),
    employees: module.get(EmployeesService),
    balances: module.get(BalancesService),
    hcm: module.get(MockHcmService),
    timeOff: module.get(TimeOffService),
    outbox: module.get(OutboxService),
    sync: module.get(SyncService),
    close: async () => {
      await module.close();
    },
  };
}

export interface SeedOptions {
  employeeId?: string;
  hcmEmployeeId?: string;
  locationId?: string;
  hcmLocationId?: string;
  vacationMinutes?: number;
  sickMinutes?: number;
}

export function seedEmployee(
  h: TestHarness,
  opts: SeedOptions = {},
): {
  employeeId: string;
  locationId: string;
  hcmEmployeeId: string;
  hcmLocationId: string;
} {
  const employeeId = opts.employeeId ?? 'emp-1';
  const hcmEmployeeId = opts.hcmEmployeeId ?? `wd-${employeeId}`;
  const locationId = opts.locationId ?? 'loc-NYC';
  const hcmLocationId = opts.hcmLocationId ?? `wd-${locationId}`;
  const vacation = opts.vacationMinutes ?? 4800;
  const sick = opts.sickMinutes ?? 2400;

  h.employees.upsertEmployee({
    id: employeeId,
    hcmEmployeeId,
    name: `Test ${employeeId}`,
  });
  h.employees.upsertLocation({
    id: locationId,
    hcmLocationId,
    name: `Loc ${locationId}`,
  });
  h.hcm.seedBalance({
    hcmEmployeeId,
    hcmLocationId,
    leaveType: 'VACATION',
    balanceMinutes: vacation,
  });
  h.hcm.seedBalance({
    hcmEmployeeId,
    hcmLocationId,
    leaveType: 'SICK',
    balanceMinutes: sick,
  });
  h.balances.applyHcmBalance({
    employeeId,
    locationId,
    leaveType: 'VACATION',
    newHcmMinutes: vacation,
    cause: 'HCM_RECONCILE',
  });
  h.balances.applyHcmBalance({
    employeeId,
    locationId,
    leaveType: 'SICK',
    newHcmMinutes: sick,
    cause: 'HCM_RECONCILE',
  });
  return { employeeId, locationId, hcmEmployeeId, hcmLocationId };
}
