import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DomainError } from '../common/errors';
import { IdempotencyService } from '../common/idempotency.service';
import { ApproveDto, CancelDto, CreateTimeOffDto } from './dto';
import { TimeOffService } from './time-off.service';

@ApiTags('time-off')
@Controller()
export class TimeOffController {
  constructor(
    private readonly service: TimeOffService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post('time-off-requests')
  @HttpCode(201)
  create(
    @Body() dto: CreateTimeOffDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (idempotencyKey) {
      const stored = this.idempotency.lookup<unknown>(
        idempotencyKey,
        'POST /time-off-requests',
        dto,
      );
      if (stored) return stored.body;
    }
    const created = this.service.create(dto, idempotencyKey);
    if (idempotencyKey) {
      this.idempotency.store(idempotencyKey, 'POST /time-off-requests', dto, {
        status: 201,
        body: created,
      });
    }
    return created;
  }

  @Get('time-off-requests/:id')
  get(@Param('id') id: string) {
    const r = this.service.get(id);
    if (!r) throw DomainError.requestNotFound(id);
    return r;
  }

  @Get('employees/:employeeId/time-off-requests')
  list(@Param('employeeId') employeeId: string) {
    return { items: this.service.list(employeeId) };
  }

  @Post('time-off-requests/:id/approve')
  @HttpCode(200)
  async approve(@Param('id') id: string, @Body() body: ApproveDto) {
    return this.service.approve(id, body.managerId);
  }

  @Post('time-off-requests/:id/cancel')
  @HttpCode(200)
  async cancel(@Param('id') id: string, @Body() body: CancelDto) {
    return this.service.cancel(id, body.actorId);
  }
}
