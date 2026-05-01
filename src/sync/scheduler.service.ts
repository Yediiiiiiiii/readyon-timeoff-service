import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { OutboxService } from './outbox.service';
import { SyncService } from './sync.service';

const OUTBOX_INTERVAL_MS = Number(process.env.OUTBOX_INTERVAL_MS ?? 1000);
const FULL_SYNC_INTERVAL_MS = Number(
  process.env.FULL_SYNC_INTERVAL_MS ?? 15 * 60_000,
);

/**
 * Lightweight scheduler — no external cron dependency. Disabled in tests via
 * `DISABLE_SCHEDULER=1` so suites can drive timing deterministically.
 */
@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private outboxTimer: NodeJS.Timeout | null = null;
  private fullSyncTimer: NodeJS.Timeout | null = null;
  private busyOutbox = false;
  private busyFullSync = false;

  constructor(
    private readonly outbox: OutboxService,
    private readonly sync: SyncService,
  ) {}

  onModuleInit() {
    if (process.env.DISABLE_SCHEDULER === '1') {
      this.logger.log('Scheduler disabled via env');
      return;
    }
    this.outboxTimer = setInterval(() => {
      void this.runOutbox();
    }, OUTBOX_INTERVAL_MS).unref();
    this.fullSyncTimer = setInterval(() => {
      void this.runFullSync();
    }, FULL_SYNC_INTERVAL_MS).unref();
  }

  onModuleDestroy() {
    if (this.outboxTimer) clearInterval(this.outboxTimer);
    if (this.fullSyncTimer) clearInterval(this.fullSyncTimer);
  }

  private async runOutbox() {
    if (this.busyOutbox) return;
    this.busyOutbox = true;
    try {
      await this.outbox.flushOnce();
    } catch (err) {
      this.logger.error(`Outbox flush failed: ${(err as Error).message}`);
    } finally {
      this.busyOutbox = false;
    }
  }

  private async runFullSync() {
    if (this.busyFullSync) return;
    this.busyFullSync = true;
    try {
      const r = await this.sync.fullSync();
      this.logger.log(
        `Periodic full sync scanned=${r.scanned} updated=${r.updated} new=${r.newBalances}`,
      );
    } catch (err) {
      this.logger.error(`Full sync failed: ${(err as Error).message}`);
    } finally {
      this.busyFullSync = false;
    }
  }
}
