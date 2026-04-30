import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { BalancesModule } from './balances/balances.module';
import { CommonModule } from './common/common.module';
import { DbModule } from './db/db.module';
import { EmployeesModule } from './employees/employees.module';
import { HcmModule } from './hcm/hcm.module';
import { HealthController } from './health.controller';
import { SyncModule } from './sync/sync.module';
import { TimeOffModule } from './time-off/time-off.module';

@Module({
  imports: [
    DbModule,
    CommonModule,
    HcmModule.forRoot(),
    EmployeesModule,
    BalancesModule,
    SyncModule,
    TimeOffModule,
  ],
  controllers: [HealthController, AdminController],
})
export class AppModule {}
