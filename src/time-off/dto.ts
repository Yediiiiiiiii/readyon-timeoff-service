import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';
import { LEAVE_TYPES } from '../domain/types';
import type { LeaveType } from '../domain/types';

export class CreateTimeOffDto {
  @IsString()
  @MinLength(1)
  employeeId!: string;

  @IsString()
  @MinLength(1)
  locationId!: string;

  @IsIn(LEAVE_TYPES)
  leaveType!: LeaveType;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsInt()
  @Min(1)
  durationMinutes!: number;

  @IsOptional()
  @IsString()
  reason?: string;
}

export class ApproveDto {
  @IsString()
  @MinLength(1)
  managerId!: string;
}

export class CancelDto {
  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  actorId?: string;
}

export class HcmWebhookDto {
  @IsString()
  hcmEmployeeId!: string;

  @IsString()
  hcmLocationId!: string;

  @IsIn(LEAVE_TYPES)
  leaveType!: LeaveType;

  @IsInt()
  @Min(0)
  balanceMinutes!: number;

  @IsOptional()
  @IsString()
  version?: string;

  @IsOptional()
  @IsDateString()
  occurredAt?: string;
}
