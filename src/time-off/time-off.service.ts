import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID as uuid } from 'crypto';
import type { Database } from 'better-sqlite3';
import { Clock } from '../common/clock';
import { DomainError } from '../common/errors';
import { DbService } from '../db/db.service';
import { BalancesService } from '../balances/balances.service';
import { EmployeesService } from '../employees/employees.service';
import { OutboxService } from '../sync/outbox.service';
import {
  HcmClient,
  HcmFileRequest,
  HcmTransientError,
} from '../hcm/hcm-client';
import {
  RequestStatus,
  TimeOffRequestRow,
  TimeOffRequestView,
} from '../domain/types';
import { CreateTimeOffDto } from './dto';

@Injectable()
export class TimeOffService implements OnModuleInit {
  private readonly logger = new Logger(TimeOffService.name);

  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly balances: BalancesService,
    private readonly employees: EmployeesService,
    private readonly outbox: OutboxService,
    private readonly hcm: HcmClient,
  ) {}

  onModuleInit() {
    this.outbox.registerEvents({
      onFileSuccess: (db, payload, hcmRequestId) => {
        this.applyFileSuccessTx(db, payload.request, hcmRequestId);
      },
      onFilePermanentFail: (db, payload, error) => {
        this.applyFileFailTx(db, payload.request, error);
      },
      onCancelSuccess: (db, payload) => {
        this.applyCancelSuccessTx(db, payload.requestId, payload.hcmRequestId);
      },
      onCancelPermanentFail: (_db, payload, error) => {
        this.logger.warn(
          `Outbox cancel for request=${payload.requestId} permanently failed: ${error}`,
        );
      },
    });
  }

  /* -------------------------------------------------------------- create */

  create(dto: CreateTimeOffDto, idempotencyKey?: string): TimeOffRequestView {
    this.employees.requireEmployee(dto.employeeId);
    this.employees.requireLocation(dto.locationId);

    if (dto.startDate > dto.endDate) {
      throw DomainError.invalidInput('startDate must be <= endDate');
    }

    return this.db.transaction((db) => {
      const id = uuid();
      const now = this.clock.nowIso();
      db.prepare(
        `INSERT INTO time_off_requests
           (id, employee_id, location_id, leave_type, start_date, end_date,
            duration_minutes, status, reason, hcm_request_id, idempotency_key,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, NULL, ?, ?, ?)`,
      ).run(
        id,
        dto.employeeId,
        dto.locationId,
        dto.leaveType,
        dto.startDate,
        dto.endDate,
        dto.durationMinutes,
        dto.reason ?? null,
        idempotencyKey ?? null,
        now,
        now,
      );
      this.balances.reserveTx(
        db,
        dto.employeeId,
        dto.locationId,
        dto.leaveType,
        dto.durationMinutes,
        {
          cause: 'REQUEST_CREATED',
          actor: `employee:${dto.employeeId}`,
          requestId: id,
        },
      );
      return this.toView(this.requireTx(db, id));
    });
  }

  /* ------------------------------------------------------------- approve */

  /**
   * Approve a PENDING request. Re-reads HCM realtime for defensive validation.
   * If HCM disagrees with the local view, we apply HCM's truth to our state
   * (keeping reservations) and re-evaluate.
   */
  async approve(id: string, managerId: string): Promise<TimeOffRequestView> {
    const req = this.require(id);
    if (req.status !== 'PENDING') {
      throw DomainError.illegalTransition(req.status, 'APPROVED');
    }
    const employee = this.employees.requireEmployee(req.employee_id);
    const location = this.employees.requireLocation(req.location_id);

    // Defensive realtime re-check; reconciles drift before we approve.
    try {
      const hcmRows = await this.hcm.getBalances({
        hcmEmployeeId: employee.hcm_employee_id,
        hcmLocationId: location.hcm_location_id,
      });
      const match = hcmRows.find((r) => r.leaveType === req.leave_type);
      if (match) {
        this.balances.applyHcmBalance({
          employeeId: req.employee_id,
          locationId: req.location_id,
          leaveType: req.leave_type,
          newHcmMinutes: match.balanceMinutes,
          hcmVersion: match.version,
          cause: 'HCM_RECONCILE',
          actor: 'system',
          note: `pre-approve realtime check (manager=${managerId})`,
        });
      }
    } catch (err) {
      if (err instanceof HcmTransientError) {
        throw DomainError.hcmUnavailable(
          'HCM unavailable during pre-approve check; retry shortly',
        );
      }
      throw err;
    }

    const fresh = this.balances.get(
      req.employee_id,
      req.location_id,
      req.leave_type,
    );
    if (!fresh) {
      throw DomainError.balanceNotFound('Balance vanished during approval');
    }
    if (fresh.hcm_balance_minutes < req.duration_minutes) {
      // HCM says we don't have it. Mark FAILED and release reservation.
      this.db.transaction((db) => {
        this.balances.releaseTx(
          db,
          req.employee_id,
          req.location_id,
          req.leave_type,
          req.duration_minutes,
          {
            cause: 'REQUEST_FAILED',
            actor: `manager:${managerId}`,
            requestId: id,
            note: 'HCM disagreed at approve-time',
          },
        );
        this.setStatusTx(db, id, 'FAILED');
      });
      throw DomainError.insufficientBalance(
        'HCM reports insufficient balance at approval time',
      );
    }

    return this.db.transaction((db) => {
      this.setStatusTx(db, id, 'APPROVED');
      const employeeRec = this.employees.requireEmployee(req.employee_id);
      const locationRec = this.employees.requireLocation(req.location_id);
      const filePayload: HcmFileRequest = {
        requestId: id,
        hcmEmployeeId: employeeRec.hcm_employee_id,
        hcmLocationId: locationRec.hcm_location_id,
        leaveType: req.leave_type,
        startDate: req.start_date,
        endDate: req.end_date,
        durationMinutes: req.duration_minutes,
      };
      this.outbox.enqueueTx(
        db,
        'HCM_FILE_TIMEOFF',
        { request: filePayload },
        id,
      );
      this.appendLedgerForRequestTx(
        db,
        req,
        'REQUEST_APPROVED',
        `manager:${managerId}`,
      );
      return this.toView(this.requireTx(db, id));
    });
  }

  /* -------------------------------------------------------------- cancel */

  // eslint-disable-next-line @typescript-eslint/require-await
  async cancel(id: string, actorId?: string): Promise<TimeOffRequestView> {
    const req = this.require(id);
    if (req.status === 'CANCELLED') return this.toView(req);
    if (req.status === 'FAILED' || req.status === 'REJECTED') {
      throw DomainError.illegalTransition(req.status, 'CANCELLED');
    }

    if (req.status === 'PENDING') {
      this.db.transaction((db) => {
        this.balances.releaseTx(
          db,
          req.employee_id,
          req.location_id,
          req.leave_type,
          req.duration_minutes,
          {
            cause: 'REQUEST_CANCELLED',
            actor: actorId ?? `employee:${req.employee_id}`,
            requestId: id,
          },
        );
        this.setStatusTx(db, id, 'CANCELLED');
      });
      return this.toView(this.require(id));
    }

    if (req.status === 'APPROVED') {
      // Two sub-cases: file already succeeded (hcm_request_id set) or still in outbox.
      const pendingOutbox = this.outbox
        .byRequestId(id)
        .find((r) => r.type === 'HCM_FILE_TIMEOFF' && r.status === 'PENDING');

      if (pendingOutbox) {
        // File never went out — kill the outbox row, release reservation.
        this.db.transaction((db) => {
          this.outbox.cancelPendingTx(db, pendingOutbox.id);
          this.balances.releaseTx(
            db,
            req.employee_id,
            req.location_id,
            req.leave_type,
            req.duration_minutes,
            {
              cause: 'REQUEST_CANCELLED',
              actor: actorId ?? `employee:${req.employee_id}`,
              requestId: id,
              note: 'cancel before HCM file',
            },
          );
          this.setStatusTx(db, id, 'CANCELLED');
        });
        return this.toView(this.require(id));
      }

      if (req.hcm_request_id) {
        // File succeeded — enqueue HCM cancel via outbox; mark CANCELLED locally.
        this.db.transaction((db) => {
          this.outbox.enqueueTx(
            db,
            'HCM_CANCEL_TIMEOFF',
            { hcmRequestId: req.hcm_request_id, requestId: id },
            id,
          );
          this.setStatusTx(db, id, 'CANCELLED');
          this.appendLedgerForRequestTx(
            db,
            req,
            'REQUEST_CANCELLED',
            actorId ?? `employee:${req.employee_id}`,
          );
        });
        return this.toView(this.require(id));
      }

      // Edge: APPROVED with no outbox row and no hcm_request_id — should not happen
      throw DomainError.illegalTransition(req.status, 'CANCELLED');
    }

    throw DomainError.illegalTransition(req.status, 'CANCELLED');
  }

  /* ----------------------------------------------------- outbox callbacks */

  private applyFileSuccessTx(
    db: Database,
    request: HcmFileRequest,
    hcmRequestId: string,
  ) {
    db.prepare(
      `UPDATE time_off_requests SET hcm_request_id = ?, updated_at = ? WHERE id = ?`,
    ).run(hcmRequestId, this.clock.nowIso(), request.requestId);
    const req = this.requireTx(db, request.requestId);
    this.balances.settleReservationTx(
      db,
      req.employee_id,
      req.location_id,
      req.leave_type,
      req.duration_minutes,
      {
        cause: 'REQUEST_APPROVED',
        actor: 'system:outbox',
        requestId: req.id,
        note: `HCM filed as ${hcmRequestId}`,
      },
    );
  }

  private applyFileFailTx(
    db: Database,
    request: HcmFileRequest,
    error: string,
  ) {
    const req = this.requireTx(db, request.requestId);
    if (req.status !== 'CANCELLED') {
      this.balances.releaseTx(
        db,
        req.employee_id,
        req.location_id,
        req.leave_type,
        req.duration_minutes,
        {
          cause: 'REQUEST_FAILED',
          actor: 'system:outbox',
          requestId: req.id,
          note: `HCM permanent error: ${error.slice(0, 200)}`,
        },
      );
      db.prepare(
        `UPDATE time_off_requests SET status='FAILED', updated_at=? WHERE id=?`,
      ).run(this.clock.nowIso(), req.id);
    }
  }

  private applyCancelSuccessTx(
    db: Database,
    requestId: string,
    hcmRequestId: string,
  ) {
    const req = this.requireTx(db, requestId);
    // HCM has now refunded; bump our hcm_balance back.
    db.prepare(
      `UPDATE balances
          SET hcm_balance_minutes = hcm_balance_minutes + ?, version = version + 1, last_synced_at = ?
        WHERE employee_id = ? AND location_id = ? AND leave_type = ?`,
    ).run(
      req.duration_minutes,
      this.clock.nowIso(),
      req.employee_id,
      req.location_id,
      req.leave_type,
    );
    const fresh = this.balances.get(
      req.employee_id,
      req.location_id,
      req.leave_type,
      db,
    )!;
    db.prepare(
      `INSERT INTO balance_ledger
         (employee_id, location_id, leave_type, delta_minutes,
          hcm_balance_after, reserved_after, cause, request_id, actor, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'REQUEST_CANCELLED', ?, 'system:outbox', ?, ?)`,
    ).run(
      req.employee_id,
      req.location_id,
      req.leave_type,
      req.duration_minutes,
      fresh.hcm_balance_minutes,
      fresh.reserved_minutes,
      req.id,
      `HCM cancelled ${hcmRequestId}`,
      this.clock.nowIso(),
    );
  }

  /* ---------------------------------------------------------------- read */

  list(employeeId: string): TimeOffRequestView[] {
    const rows = this.db.db
      .prepare(
        `SELECT * FROM time_off_requests WHERE employee_id = ? ORDER BY created_at DESC`,
      )
      .all(employeeId) as TimeOffRequestRow[];
    return rows.map((r) => this.toView(r));
  }

  listAll(limit = 50): TimeOffRequestView[] {
    const max = Math.min(Math.max(limit, 1), 500);
    const rows = this.db.db
      .prepare(
        `SELECT * FROM time_off_requests ORDER BY created_at DESC LIMIT ?`,
      )
      .all(max) as TimeOffRequestRow[];
    return rows.map((r) => this.toView(r));
  }

  get(id: string): TimeOffRequestView | null {
    const row = this.findById(id);
    return row ? this.toView(row) : null;
  }

  findById(id: string): TimeOffRequestRow | null {
    const row = this.db.db
      .prepare(`SELECT * FROM time_off_requests WHERE id = ?`)
      .get(id) as TimeOffRequestRow | undefined;
    return row ?? null;
  }

  findByIdempotencyKey(key: string): TimeOffRequestRow | null {
    const row = this.db.db
      .prepare(`SELECT * FROM time_off_requests WHERE idempotency_key = ?`)
      .get(key) as TimeOffRequestRow | undefined;
    return row ?? null;
  }

  require(id: string): TimeOffRequestRow {
    const r = this.findById(id);
    if (!r) throw DomainError.requestNotFound(id);
    return r;
  }

  private requireTx(db: Database, id: string): TimeOffRequestRow {
    const r = db
      .prepare(`SELECT * FROM time_off_requests WHERE id = ?`)
      .get(id) as TimeOffRequestRow | undefined;
    if (!r) throw DomainError.requestNotFound(id);
    return r;
  }

  /* --------------------------------------------------------------- helpers */

  private setStatusTx(db: Database, id: string, status: RequestStatus) {
    db.prepare(
      `UPDATE time_off_requests SET status = ?, updated_at = ? WHERE id = ?`,
    ).run(status, this.clock.nowIso(), id);
  }

  private appendLedgerForRequestTx(
    db: Database,
    req: TimeOffRequestRow,
    cause: 'REQUEST_APPROVED' | 'REQUEST_CANCELLED' | 'REQUEST_FAILED',
    actor: string,
  ) {
    const fresh = this.balances.get(
      req.employee_id,
      req.location_id,
      req.leave_type,
      db,
    )!;
    db.prepare(
      `INSERT INTO balance_ledger
         (employee_id, location_id, leave_type, delta_minutes,
          hcm_balance_after, reserved_after, cause, request_id, actor, note, created_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      req.employee_id,
      req.location_id,
      req.leave_type,
      fresh.hcm_balance_minutes,
      fresh.reserved_minutes,
      cause,
      req.id,
      actor,
      this.clock.nowIso(),
    );
  }

  private toView(r: TimeOffRequestRow): TimeOffRequestView {
    return {
      id: r.id,
      employeeId: r.employee_id,
      locationId: r.location_id,
      leaveType: r.leave_type,
      startDate: r.start_date,
      endDate: r.end_date,
      durationMinutes: r.duration_minutes,
      status: r.status,
      reason: r.reason,
      hcmRequestId: r.hcm_request_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
