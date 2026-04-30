import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { LEAVE_TYPES } from '../domain/types';
import type { LeaveType } from '../domain/types';
import { HcmPermanentError, HcmTransientError } from './hcm-client';
import { MockHcmService } from './mock-hcm.service';

class LookupBalancesDto {
  @IsString() hcmEmployeeId!: string;
  @IsString() hcmLocationId!: string;
}

class FileTimeOffDto {
  @IsString() requestId!: string;
  @IsString() hcmEmployeeId!: string;
  @IsString() hcmLocationId!: string;
  @IsIn(LEAVE_TYPES) leaveType!: LeaveType;
  @IsString() startDate!: string;
  @IsString() endDate!: string;
  @IsInt() @Min(1) durationMinutes!: number;
}

class SeedBalanceDto {
  @IsString() hcmEmployeeId!: string;
  @IsString() hcmLocationId!: string;
  @IsIn(LEAVE_TYPES) leaveType!: LeaveType;
  @IsInt() @Min(0) balanceMinutes!: number;
}

class BumpBalanceDto {
  @IsString() hcmEmployeeId!: string;
  @IsString() hcmLocationId!: string;
  @IsIn(LEAVE_TYPES) leaveType!: LeaveType;
  @IsInt() deltaMinutes!: number;
}

class FailureModesDto {
  @IsOptional() @IsInt() fileTimeOffTransientUntil?: number;
  @IsOptional() fileTimeOffPermanent?: boolean;
  @IsOptional() getBalancesTransient?: boolean;
  @IsOptional() listAllTransient?: boolean;
}

/**
 * Real HTTP surface for the in-process Mock HCM. Lets reviewers (and
 * `HttpHcmClient`) talk to it the same way they'd talk to a real Workday
 * endpoint. In production this controller would not be mounted; it lives
 * here for tests, dev, and demos.
 *
 * Mounting is gated by env: set `ENABLE_MOCK_HCM=1` (defaulted on in dev).
 */
@ApiTags('mock-hcm')
@Controller('mock-hcm')
export class MockHcmController {
  constructor(private readonly mock: MockHcmService) {}

  @Post('balances/lookup')
  @HttpCode(200)
  async lookup(@Body() dto: LookupBalancesDto) {
    return await this.run(() => this.mock.getBalances(dto));
  }

  @Get('balances')
  async listAll(@Query('cursor') cursor?: string) {
    return await this.run(() =>
      this.mock.listAllBalances({ cursor: cursor ?? null }),
    );
  }

  @Post('timeoff')
  @HttpCode(201)
  async file(@Body() dto: FileTimeOffDto) {
    return await this.run(() => this.mock.fileTimeOff(dto));
  }

  @Delete('timeoff/:hcmRequestId')
  @HttpCode(204)
  async cancel(@Param('hcmRequestId') hcmRequestId: string) {
    await this.run(() => this.mock.cancelTimeOff({ hcmRequestId }));
  }

  /* ------------------------- admin / test endpoints -------------------------*/

  @Post('admin/seed-balance')
  @HttpCode(204)
  seed(@Body() dto: SeedBalanceDto) {
    this.mock.seedBalance(dto);
  }

  @Post('admin/bump-balance')
  @HttpCode(200)
  bump(@Body() dto: BumpBalanceDto) {
    const r = this.mock.bumpBalance(
      {
        hcmEmployeeId: dto.hcmEmployeeId,
        hcmLocationId: dto.hcmLocationId,
        leaveType: dto.leaveType,
      },
      dto.deltaMinutes,
    );
    return {
      hcmEmployeeId: r.hcmEmployeeId,
      hcmLocationId: r.hcmLocationId,
      leaveType: r.leaveType,
      balanceMinutes: r.balanceMinutes,
      version: r.version,
    };
  }

  @Post('admin/failures')
  @HttpCode(200)
  setFailures(@Body() dto: FailureModesDto) {
    if (typeof dto.fileTimeOffTransientUntil === 'number') {
      this.mock.failures.fileTimeOffTransientUntil =
        dto.fileTimeOffTransientUntil;
    }
    if (typeof dto.fileTimeOffPermanent === 'boolean') {
      this.mock.failures.fileTimeOffPermanent = dto.fileTimeOffPermanent;
    }
    if (typeof dto.getBalancesTransient === 'boolean') {
      this.mock.failures.getBalancesTransient = dto.getBalancesTransient;
    }
    if (typeof dto.listAllTransient === 'boolean') {
      this.mock.failures.listAllTransient = dto.listAllTransient;
    }
    return this.mock.failures;
  }

  @Post('admin/reset')
  @HttpCode(204)
  reset() {
    this.mock.reset();
  }

  /** Translate HcmClient errors into the right HTTP status codes. */
  private async run<T>(fn: () => Promise<T> | T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HcmTransientError) {
        throw new HttpException(
          {
            type: 'hcm-transient',
            code: 'HCM_TRANSIENT',
            message: err.message,
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      if (err instanceof HcmPermanentError) {
        throw new HttpException(
          {
            type: 'hcm-permanent',
            code: 'HCM_PERMANENT',
            message: err.message,
          },
          HttpStatus.BAD_REQUEST,
        );
      }
      throw err;
    }
  }
}
