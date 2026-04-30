import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { join } from 'path';
import { AppModule } from '../src/app.module';
import { BalancesService } from '../src/balances/balances.service';
import { applyStaticDashboard } from '../src/bootstrap';
import { Clock } from '../src/common/clock';
import { DbService } from '../src/db/db.service';
import { EmployeesService } from '../src/employees/employees.service';
import { MockHcmService } from '../src/hcm/mock-hcm.service';
import { OutboxService } from '../src/sync/outbox.service';
import { SyncService } from '../src/sync/sync.service';
import { TimeOffService } from '../src/time-off/time-off.service';

process.env.DISABLE_SCHEDULER = '1';
process.env.DB_PATH = ':memory:';

export interface E2eHarness {
  app: INestApplication;
  url: string;
  hcm: MockHcmService;
  db: DbService;
  clock: Clock;
  employees: EmployeesService;
  balances: BalancesService;
  timeOff: TimeOffService;
  outbox: OutboxService;
  sync: SyncService;
  close: () => Promise<void>;
}

export async function startE2e(): Promise<E2eHarness> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  applyStaticDashboard(app, join(process.cwd(), 'public'));
  await app.init();
  await app.listen(0); // any free port
  const url = await app.getUrl();
  return {
    app,
    url,
    hcm: app.get(MockHcmService),
    db: app.get(DbService),
    clock: app.get(Clock),
    employees: app.get(EmployeesService),
    balances: app.get(BalancesService),
    timeOff: app.get(TimeOffService),
    outbox: app.get(OutboxService),
    sync: app.get(SyncService),
    close: async () => {
      await app.close();
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

export function seed(h: E2eHarness, opts: SeedOptions = {}) {
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
