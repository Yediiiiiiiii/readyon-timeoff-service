import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsArray, IsIn, IsInt, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { LEAVE_TYPES } from './domain/types';
import type { LeaveType } from './domain/types';
import { EmployeesService } from './employees/employees.service';
import { MockHcmService } from './hcm/mock-hcm.service';
import { SyncService } from './sync/sync.service';

class SeedBalanceDto {
  @IsString() locationId!: string;
  @IsString() hcmLocationId!: string;
  @IsIn(LEAVE_TYPES) leaveType!: LeaveType;
  @IsInt() @Min(0) balanceMinutes!: number;
}

class SeedEmployeeDto {
  @IsString() employeeId!: string;
  @IsString() hcmEmployeeId!: string;
  @IsString() name!: string;

  @IsArray()
  @Type(() => SeedBalanceDto)
  balances!: SeedBalanceDto[];
}

class SeedDto {
  @IsArray()
  @Type(() => SeedEmployeeDto)
  employees!: SeedEmployeeDto[];
}

/**
 * Dev/demo seeding. Pre-loads ReadyOn + Mock HCM with a consistent dataset
 * so a reviewer can `curl localhost:3000/admin/seed -d @demo.json` and then
 * exercise every API end-to-end.
 *
 * In production this controller would be either removed or gated behind ops
 * auth. For v1 it's plain HTTP.
 */
@ApiTags('admin')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly employees: EmployeesService,
    private readonly mock: MockHcmService,
    private readonly sync: SyncService,
  ) {}

  @Post('seed')
  @HttpCode(200)
  async seed(@Body() dto: SeedDto) {
    for (const emp of dto.employees) {
      this.employees.upsertEmployee({
        id: emp.employeeId,
        hcmEmployeeId: emp.hcmEmployeeId,
        name: emp.name,
      });
      for (const b of emp.balances) {
        this.employees.upsertLocation({
          id: b.locationId,
          hcmLocationId: b.hcmLocationId,
          name: b.locationId,
        });
        this.mock.seedBalance({
          hcmEmployeeId: emp.hcmEmployeeId,
          hcmLocationId: b.hcmLocationId,
          leaveType: b.leaveType,
          balanceMinutes: b.balanceMinutes,
        });
      }
    }
    const reconcile = await this.sync.fullSync();
    return { seededEmployees: dto.employees.length, reconcile };
  }
}
