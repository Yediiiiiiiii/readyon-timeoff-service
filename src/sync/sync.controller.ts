import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { OutboxService } from './outbox.service';
import { SyncService } from './sync.service';
import { HcmWebhookDto } from '../time-off/dto';

@ApiTags('sync')
@Controller()
export class SyncController {
  constructor(
    private readonly sync: SyncService,
    private readonly outbox: OutboxService,
  ) {}

  @Post('webhooks/hcm/balance-updated')
  @HttpCode(202)
  webhook(@Body() dto: HcmWebhookDto) {
    return this.sync.applyWebhook({
      hcmEmployeeId: dto.hcmEmployeeId,
      hcmLocationId: dto.hcmLocationId,
      leaveType: dto.leaveType,
      balanceMinutes: dto.balanceMinutes,
      version: dto.version ?? null,
      occurredAt: dto.occurredAt,
    });
  }

  @Post('admin/sync/full')
  @HttpCode(200)
  async fullSync() {
    return this.sync.fullSync();
  }

  @Post('admin/sync/employee/:employeeId')
  @HttpCode(200)
  async employeeSync(@Param('employeeId') employeeId: string) {
    return this.sync.reconcileEmployee(employeeId);
  }

  @Post('admin/outbox/flush')
  @HttpCode(200)
  async flushOutbox() {
    return this.outbox.flushOnce();
  }

  @Get('admin/outbox')
  outboxStatus() {
    return {
      stats: this.outbox.stats(),
      recent: this.outbox.recent(25),
    };
  }
}
