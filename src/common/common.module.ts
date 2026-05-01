import { Global, Module } from '@nestjs/common';
import { Clock } from './clock';
import { IdempotencyService } from './idempotency.service';

@Global()
@Module({
  providers: [Clock, IdempotencyService],
  exports: [Clock, IdempotencyService],
})
export class CommonModule {}
