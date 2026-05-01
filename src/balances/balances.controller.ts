import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { LeaveType } from '../domain/types';
import { EmployeesService } from '../employees/employees.service';
import { DomainError } from '../common/errors';
import { BalancesService } from './balances.service';

@ApiTags('balances')
@Controller()
export class BalancesController {
  constructor(
    private readonly balances: BalancesService,
    private readonly employees: EmployeesService,
  ) {}

  @Get('employees')
  listEmployees() {
    return { items: this.employees.listEmployees() };
  }

  @Get('employees/:employeeId/balances')
  list(@Param('employeeId') employeeId: string) {
    this.employees.requireEmployee(employeeId);
    return { items: this.balances.list(employeeId) };
  }

  @Get('employees/:employeeId/balances/:locationId/:leaveType')
  one(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
    @Param('leaveType') leaveType: string,
  ) {
    this.employees.requireEmployee(employeeId);
    this.employees.requireLocation(locationId);
    const view = this.balances.view(
      employeeId,
      locationId,
      leaveType as LeaveType,
    );
    if (!view) {
      throw DomainError.balanceNotFound(
        `No balance for ${employeeId}/${locationId}/${leaveType}`,
      );
    }
    return view;
  }

  @Get('employees/:employeeId/ledger')
  ledger(
    @Param('employeeId') employeeId: string,
    @Query('limit') limit?: string,
  ) {
    this.employees.requireEmployee(employeeId);
    const all = this.balances.ledger(employeeId);
    const max = Math.min(Math.max(Number(limit) || 50, 1), 500);
    return { items: all.slice(-max).reverse() };
  }
}
