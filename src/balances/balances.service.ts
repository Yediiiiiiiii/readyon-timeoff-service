import { Injectable, Logger } from '@nestjs/common';
import type { Database } from 'better-sqlite3';
import { Clock } from '../common/clock';
import { DomainError } from '../common/errors';
import { DbService } from '../db/db.service';
import {
  BalanceRow,
  BalanceView,
  LeaveType,
  LedgerCause,
} from '../domain/types';

export interface AdjustOptions {
  cause: LedgerCause;
  actor?: string;
  requestId?: string;
  note?: string;
}

@Injectable()
export class BalancesService {
  private readonly logger = new Logger(BalancesService.name);

  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
  ) {}

  /**
   * Idempotently create a balance row at zero. Used the first time we hear
   * about a (employee, location, leave_type) tuple from HCM.
   */
  ensureBalance(
    employeeId: string,
    locationId: string,
    leaveType: LeaveType,
    initialMinutes = 0,
    db: Database = this.db.db,
  ): void {
    const exists = db
      .prepare(
        `SELECT 1 FROM balances
          WHERE employee_id = ? AND location_id = ? AND leave_type = ?`,
      )
      .get(employeeId, locationId, leaveType);
    if (exists) return;
    db.prepare(
      `INSERT INTO balances
         (employee_id, location_id, leave_type, hcm_balance_minutes,
          reserved_minutes, version, hcm_version, last_synced_at)
       VALUES (?, ?, ?, ?, 0, 0, NULL, ?)`,
    ).run(
      employeeId,
      locationId,
      leaveType,
      initialMinutes,
      this.clock.nowIso(),
    );
  }

  list(employeeId: string): BalanceView[] {
    const rows = this.db.db
      .prepare(
        `SELECT * FROM balances WHERE employee_id = ? ORDER BY location_id, leave_type`,
      )
      .all(employeeId) as BalanceRow[];
    return rows.map((r) => this.toView(r));
  }

  get(
    employeeId: string,
    locationId: string,
    leaveType: LeaveType,
    db: Database = this.db.db,
  ): BalanceRow | null {
    const row = db
      .prepare(
        `SELECT * FROM balances
          WHERE employee_id = ? AND location_id = ? AND leave_type = ?`,
      )
      .get(employeeId, locationId, leaveType) as BalanceRow | undefined;
    return row ?? null;
  }

  view(
    employeeId: string,
    locationId: string,
    leaveType: LeaveType,
  ): BalanceView | null {
    const row = this.get(employeeId, locationId, leaveType);
    return row ? this.toView(row) : null;
  }

  /**
   * Reserve `minutes` against an employee's balance, atomically.
   *
   * Returns the new balance view on success. Throws INSUFFICIENT_BALANCE if
   * the reservation would violate the invariant `reserved + minutes <= hcm_balance`.
   *
   * Must be called inside a transaction (use `BalancesService.reserveTx`).
   */
  reserveTx(
    db: Database,
    employeeId: string,
    locationId: string,
    leaveType: LeaveType,
    minutes: number,
    opts: AdjustOptions,
  ): BalanceView {
    if (minutes <= 0) {
      throw DomainError.invalidInput('minutes must be positive');
    }
    const row = this.get(employeeId, locationId, leaveType, db);
    if (!row) {
      throw DomainError.balanceNotFound(
        `No balance for employee=${employeeId} location=${locationId} leaveType=${leaveType}`,
      );
    }
    const newReserved = row.reserved_minutes + minutes;
    if (newReserved > row.hcm_balance_minutes) {
      throw DomainError.insufficientBalance(
        `Need ${minutes}m but only ${
          row.hcm_balance_minutes - row.reserved_minutes
        }m available`,
      );
    }
    const result = db
      .prepare(
        `UPDATE balances
            SET reserved_minutes = ?, version = version + 1
          WHERE employee_id = ? AND location_id = ? AND leave_type = ?
            AND version = ?`,
      )
      .run(newReserved, employeeId, locationId, leaveType, row.version);
    if (result.changes !== 1) {
      throw DomainError.concurrencyConflict();
    }
    this.appendLedger(db, {
      employeeId,
      locationId,
      leaveType,
      delta: minutes,
      hcmAfter: row.hcm_balance_minutes,
      reservedAfter: newReserved,
      ...opts,
    });
    return {
      employeeId,
      locationId,
      leaveType,
      hcmBalanceMinutes: row.hcm_balance_minutes,
      reservedMinutes: newReserved,
      availableMinutes: row.hcm_balance_minutes - newReserved,
      lastSyncedAt: row.last_synced_at,
    };
  }

  /** Release a previously-held reservation (e.g., cancel a PENDING request). */
  releaseTx(
    db: Database,
    employeeId: string,
    locationId: string,
    leaveType: LeaveType,
    minutes: number,
    opts: AdjustOptions,
  ): BalanceView {
    const row = this.get(employeeId, locationId, leaveType, db);
    if (!row) {
      throw DomainError.balanceNotFound(
        `No balance for employee=${employeeId} location=${locationId} leaveType=${leaveType}`,
      );
    }
    const newReserved = Math.max(0, row.reserved_minutes - minutes);
    const result = db
      .prepare(
        `UPDATE balances
            SET reserved_minutes = ?, version = version + 1
          WHERE employee_id = ? AND location_id = ? AND leave_type = ?
            AND version = ?`,
      )
      .run(newReserved, employeeId, locationId, leaveType, row.version);
    if (result.changes !== 1) {
      throw DomainError.concurrencyConflict();
    }
    this.appendLedger(db, {
      employeeId,
      locationId,
      leaveType,
      delta: -(row.reserved_minutes - newReserved),
      hcmAfter: row.hcm_balance_minutes,
      reservedAfter: newReserved,
      ...opts,
    });
    return {
      employeeId,
      locationId,
      leaveType,
      hcmBalanceMinutes: row.hcm_balance_minutes,
      reservedMinutes: newReserved,
      availableMinutes: row.hcm_balance_minutes - newReserved,
      lastSyncedAt: row.last_synced_at,
    };
  }

  /**
   * Settle a previously-reserved chunk: HCM has now confirmed the deduction,
   * so we drop both reserved and hcm_balance by the same amount.
   */
  settleReservationTx(
    db: Database,
    employeeId: string,
    locationId: string,
    leaveType: LeaveType,
    minutes: number,
    opts: AdjustOptions,
  ): BalanceView {
    const row = this.get(employeeId, locationId, leaveType, db);
    if (!row) {
      throw DomainError.balanceNotFound(
        `No balance for employee=${employeeId} location=${locationId} leaveType=${leaveType}`,
      );
    }
    const newReserved = Math.max(0, row.reserved_minutes - minutes);
    const newHcm = Math.max(0, row.hcm_balance_minutes - minutes);
    const result = db
      .prepare(
        `UPDATE balances
            SET reserved_minutes = ?, hcm_balance_minutes = ?, version = version + 1, last_synced_at = ?
          WHERE employee_id = ? AND location_id = ? AND leave_type = ?
            AND version = ?`,
      )
      .run(
        newReserved,
        newHcm,
        this.clock.nowIso(),
        employeeId,
        locationId,
        leaveType,
        row.version,
      );
    if (result.changes !== 1) {
      throw DomainError.concurrencyConflict();
    }
    this.appendLedger(db, {
      employeeId,
      locationId,
      leaveType,
      delta: -minutes,
      hcmAfter: newHcm,
      reservedAfter: newReserved,
      ...opts,
    });
    return {
      employeeId,
      locationId,
      leaveType,
      hcmBalanceMinutes: newHcm,
      reservedMinutes: newReserved,
      availableMinutes: newHcm - newReserved,
      lastSyncedAt: this.clock.nowIso(),
    };
  }

  /**
   * HCM informs us of the new authoritative balance (webhook or batch).
   * Reservations are preserved unconditionally.
   *
   * If the new HCM balance is *less* than current reservations, we keep
   * reservations intact (they represent already-promised commitments) but
   * log a critical drift event. Subsequent settlements will simply clamp
   * hcm_balance at 0.
   */
  applyHcmBalance(input: {
    employeeId: string;
    locationId: string;
    leaveType: LeaveType;
    newHcmMinutes: number;
    hcmVersion?: string | null;
    cause: LedgerCause;
    actor?: string;
    note?: string;
  }): BalanceView {
    return this.db.transaction((db) => {
      this.ensureBalance(
        input.employeeId,
        input.locationId,
        input.leaveType,
        0,
        db,
      );
      const row = this.get(
        input.employeeId,
        input.locationId,
        input.leaveType,
        db,
      )!;
      const newHcm = Math.max(0, input.newHcmMinutes);
      const delta = newHcm - row.hcm_balance_minutes;
      if (newHcm < row.reserved_minutes) {
        this.logger.warn(
          `HCM balance ${newHcm} for employee=${input.employeeId} loc=${input.locationId} type=${input.leaveType} is below reserved ${row.reserved_minutes}`,
        );
      }
      const now = this.clock.nowIso();
      const result = db
        .prepare(
          `UPDATE balances
              SET hcm_balance_minutes = ?, hcm_version = ?, version = version + 1, last_synced_at = ?
            WHERE employee_id = ? AND location_id = ? AND leave_type = ?
              AND version = ?`,
        )
        .run(
          newHcm,
          input.hcmVersion ?? null,
          now,
          input.employeeId,
          input.locationId,
          input.leaveType,
          row.version,
        );
      if (result.changes !== 1) {
        throw DomainError.concurrencyConflict();
      }
      this.appendLedger(db, {
        employeeId: input.employeeId,
        locationId: input.locationId,
        leaveType: input.leaveType,
        delta,
        hcmAfter: newHcm,
        reservedAfter: row.reserved_minutes,
        cause: input.cause,
        actor: input.actor ?? 'hcm',
        note: input.note,
      });
      return {
        employeeId: input.employeeId,
        locationId: input.locationId,
        leaveType: input.leaveType,
        hcmBalanceMinutes: newHcm,
        reservedMinutes: row.reserved_minutes,
        availableMinutes: Math.max(0, newHcm - row.reserved_minutes),
        lastSyncedAt: now,
      };
    });
  }

  /** Read-only ledger inspection (used by tests and audit endpoints). */
  ledger(
    employeeId: string,
    locationId?: string,
    leaveType?: LeaveType,
  ): Array<{
    id: number;
    employee_id: string;
    location_id: string;
    leave_type: LeaveType;
    delta_minutes: number;
    hcm_balance_after: number;
    reserved_after: number;
    cause: LedgerCause;
    request_id: string | null;
    actor: string | null;
    note: string | null;
    created_at: string;
  }> {
    const params: unknown[] = [employeeId];
    let sql = `SELECT * FROM balance_ledger WHERE employee_id = ?`;
    if (locationId) {
      sql += ` AND location_id = ?`;
      params.push(locationId);
    }
    if (leaveType) {
      sql += ` AND leave_type = ?`;
      params.push(leaveType);
    }
    sql += ` ORDER BY id`;
    return this.db.db.prepare(sql).all(...params) as ReturnType<
      BalancesService['ledger']
    >;
  }

  private appendLedger(
    db: Database,
    e: {
      employeeId: string;
      locationId: string;
      leaveType: LeaveType;
      delta: number;
      hcmAfter: number;
      reservedAfter: number;
      cause: LedgerCause;
      actor?: string;
      requestId?: string;
      note?: string;
    },
  ) {
    db.prepare(
      `INSERT INTO balance_ledger
         (employee_id, location_id, leave_type, delta_minutes,
          hcm_balance_after, reserved_after, cause, request_id, actor, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      e.employeeId,
      e.locationId,
      e.leaveType,
      e.delta,
      e.hcmAfter,
      e.reservedAfter,
      e.cause,
      e.requestId ?? null,
      e.actor ?? 'system',
      e.note ?? null,
      this.clock.nowIso(),
    );
  }

  private toView(r: BalanceRow): BalanceView {
    return {
      employeeId: r.employee_id,
      locationId: r.location_id,
      leaveType: r.leave_type,
      hcmBalanceMinutes: r.hcm_balance_minutes,
      reservedMinutes: r.reserved_minutes,
      availableMinutes: Math.max(0, r.hcm_balance_minutes - r.reserved_minutes),
      lastSyncedAt: r.last_synced_at,
    };
  }
}
