import { Injectable, Logger } from '@nestjs/common';
import type { Database } from 'better-sqlite3';
import { Clock } from '../common/clock';
import { DbService } from '../db/db.service';
import {
  HcmClient,
  HcmFileRequest,
  HcmPermanentError,
  HcmTransientError,
} from '../hcm/hcm-client';
import { OutboxRow, OutboxStatus, OutboxType } from '../domain/types';

const BACKOFF_SCHEDULE_SECONDS = [1, 5, 30, 120, 600, 3600, 14400, 43200];
export const MAX_OUTBOX_ATTEMPTS = BACKOFF_SCHEDULE_SECONDS.length;

interface FilePayload {
  request: HcmFileRequest;
}

interface CancelPayload {
  hcmRequestId: string;
  requestId: string;
}

export interface FlushResult {
  processed: number;
  succeeded: number;
  retried: number;
  dead: number;
}

export interface OutboxEvents {
  onFileSuccess: (
    db: Database,
    payload: FilePayload,
    hcmRequestId: string,
  ) => void;
  onFilePermanentFail: (
    db: Database,
    payload: FilePayload,
    error: string,
  ) => void;
  onCancelSuccess: (db: Database, payload: CancelPayload) => void;
  onCancelPermanentFail: (
    _db: Database,
    payload: CancelPayload,
    error: string,
  ) => void;
}

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);
  private events: OutboxEvents | null = null;

  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly hcm: HcmClient,
  ) {}

  /** Wired by TimeOffService to avoid a circular dep. */
  registerEvents(events: OutboxEvents) {
    this.events = events;
  }

  enqueueTx(
    db: Database,
    type: OutboxType,
    payload: unknown,
    requestId: string,
  ): number {
    const now = this.clock.nowIso();
    const result = db
      .prepare(
        `INSERT INTO outbox
           (type, payload_json, attempts, next_attempt_at, status, request_id, created_at, updated_at)
         VALUES (?, ?, 0, ?, 'PENDING', ?, ?, ?)`,
      )
      .run(type, JSON.stringify(payload), now, requestId, now, now);
    return Number(result.lastInsertRowid);
  }

  pending(): OutboxRow[] {
    return this.db.db
      .prepare(
        `SELECT * FROM outbox
          WHERE status = 'PENDING' AND next_attempt_at <= ?
          ORDER BY id`,
      )
      .all(this.clock.nowIso()) as OutboxRow[];
  }

  byRequestId(requestId: string): OutboxRow[] {
    return this.db.db
      .prepare(`SELECT * FROM outbox WHERE request_id = ? ORDER BY id`)
      .all(requestId) as OutboxRow[];
  }

  /** Cancel an outbox row that is still PENDING (used when cancel arrives before file). */
  cancelPendingTx(db: Database, outboxId: number): boolean {
    const r = db
      .prepare(
        `UPDATE outbox SET status = 'DONE', updated_at = ?
          WHERE id = ? AND status = 'PENDING'`,
      )
      .run(this.clock.nowIso(), outboxId);
    return r.changes === 1;
  }

  /**
   * Drain pending outbox rows until none remain or max iterations reached.
   * Each row is processed in its own transaction so a partial failure leaves
   * the rest of the queue intact.
   */
  async flushOnce(maxRows = 50): Promise<FlushResult> {
    if (!this.events) {
      throw new Error('OutboxService: events not registered');
    }
    const result: FlushResult = {
      processed: 0,
      succeeded: 0,
      retried: 0,
      dead: 0,
    };
    const rows = this.pending().slice(0, maxRows);
    for (const row of rows) {
      result.processed += 1;
      const outcome = await this.processOne(row);
      if (outcome === 'succeeded') result.succeeded += 1;
      else if (outcome === 'retried') result.retried += 1;
      else if (outcome === 'dead') result.dead += 1;
    }
    return result;
  }

  private async processOne(
    row: OutboxRow,
  ): Promise<'succeeded' | 'retried' | 'dead' | 'noop'> {
    if (row.type === 'HCM_FILE_TIMEOFF') {
      const payload = JSON.parse(row.payload_json) as FilePayload;
      try {
        const res = await this.hcm.fileTimeOff(payload.request);
        this.db.transaction((db) => {
          this.markStatusTx(db, row.id, 'DONE');
          this.events!.onFileSuccess(db, payload, res.hcmRequestId);
        });
        return 'succeeded';
      } catch (err) {
        return this.handleFailure(row, err, () => {
          this.db.transaction((db) =>
            this.events!.onFilePermanentFail(
              db,
              payload,
              (err as Error).message,
            ),
          );
        });
      }
    }
    if (row.type === 'HCM_CANCEL_TIMEOFF') {
      const payload = JSON.parse(row.payload_json) as CancelPayload;
      try {
        await this.hcm.cancelTimeOff({ hcmRequestId: payload.hcmRequestId });
        this.db.transaction((db) => {
          this.markStatusTx(db, row.id, 'DONE');
          this.events!.onCancelSuccess(db, payload);
        });
        return 'succeeded';
      } catch (err) {
        return this.handleFailure(row, err, () => {
          this.db.transaction((db) =>
            this.events!.onCancelPermanentFail(
              db,
              payload,
              (err as Error).message,
            ),
          );
        });
      }
    }
    return 'noop';
  }

  private handleFailure(
    row: OutboxRow,
    err: unknown,
    onPermanent: () => void,
  ): 'retried' | 'dead' {
    const isTransient = err instanceof HcmTransientError;
    const isPermanent = err instanceof HcmPermanentError;
    const errMsg = err instanceof Error ? err.message : String(err);

    if (isPermanent) {
      this.db.transaction((db) =>
        this.markStatusTx(db, row.id, 'DEAD', errMsg),
      );
      onPermanent();
      return 'dead';
    }

    const newAttempts = row.attempts + 1;
    if (newAttempts >= MAX_OUTBOX_ATTEMPTS) {
      this.db.transaction((db) => {
        db.prepare(
          `UPDATE outbox SET status='DEAD', attempts=?, last_error=?, updated_at=? WHERE id=?`,
        ).run(newAttempts, errMsg, this.clock.nowIso(), row.id);
      });
      onPermanent();
      return 'dead';
    }

    const backoff = BACKOFF_SCHEDULE_SECONDS[newAttempts - 1] ?? 60;
    const next = new Date(this.clock.now().getTime() + backoff * 1000);
    this.db.db
      .prepare(
        `UPDATE outbox SET attempts=?, last_error=?, next_attempt_at=?, updated_at=? WHERE id=?`,
      )
      .run(
        newAttempts,
        errMsg,
        next.toISOString(),
        this.clock.nowIso(),
        row.id,
      );
    if (!isTransient) {
      this.logger.warn(
        `Outbox row ${row.id} failed with non-classified error; treating as transient`,
      );
    }
    return 'retried';
  }

  private markStatusTx(
    db: Database,
    id: number,
    status: OutboxStatus,
    error?: string | null,
  ) {
    db.prepare(
      `UPDATE outbox SET status=?, last_error=?, updated_at=? WHERE id=?`,
    ).run(status, error ?? null, this.clock.nowIso(), id);
  }
}
