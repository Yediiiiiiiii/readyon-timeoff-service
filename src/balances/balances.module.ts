import { Module } from '@nestjs/common';
import { EmployeesModule } from '../employees/employees.module';
import { BalancesController } from './balances.controller';
import { BalancesService } from './balances.service';

@Module({
  imports: [EmployeesModule],
  controllers: [BalancesController],
  providers: [BalancesService],
  exports: [BalancesService],
})
export class BalancesModule {}
