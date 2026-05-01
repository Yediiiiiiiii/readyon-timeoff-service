import { Module } from '@nestjs/common';
import { BalancesModule } from '../balances/balances.module';
import { EmployeesModule } from '../employees/employees.module';
import { OutboxService } from './outbox.service';
import { SchedulerService } from './scheduler.service';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

@Module({
  imports: [BalancesModule, EmployeesModule],
  controllers: [SyncController],
  providers: [OutboxService, SyncService, SchedulerService],
  exports: [OutboxService, SyncService],
})
export class SyncModule {}
