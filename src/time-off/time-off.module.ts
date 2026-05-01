import { Module } from '@nestjs/common';
import { BalancesModule } from '../balances/balances.module';
import { EmployeesModule } from '../employees/employees.module';
import { SyncModule } from '../sync/sync.module';
import { TimeOffController } from './time-off.controller';
import { TimeOffService } from './time-off.service';

@Module({
  imports: [BalancesModule, EmployeesModule, SyncModule],
  controllers: [TimeOffController],
  providers: [TimeOffService],
  exports: [TimeOffService],
})
export class TimeOffModule {}
