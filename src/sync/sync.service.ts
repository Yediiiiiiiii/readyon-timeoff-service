import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../common/clock';
import { DbService } from '../db/db.service';
import { BalancesService } from '../balances/balances.service';
import { EmployeesService } from '../employees/employees.service';
import { HcmClient } from '../hcm/hcm-client';
import { LeaveType } from '../domain/types';

export interface FullSyncResult {
  scanned: number;
  updated: number;
  unchanged: number;
  newBalances: number;
  newEmployees: number;
  newLocations: number;
}

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly balances: BalancesService,
    private readonly employees: EmployeesService,
    private readonly hcm: HcmClient,
  ) {}

  /**
   * Apply a single HCM webhook event. Idempotent on
   * (hcm_employee_id, hcm_location_id, leave_type, version, occurred_at).
   */
  applyWebhook(input: {
    hcmEmployeeId: string;
    hcmLocationId: string;
    leaveType: LeaveType;
    balanceMinutes: number;
    version?: string | null;
    occurredAt?: string;
  }): { applied: boolean; reason?: string } {
    const occurredAt = input.occurredAt ?? this.clock.nowIso();
    const dedupe = this.db.db
      .prepare(
        `SELECT 1 FROM hcm_webhook_events
          WHERE hcm_employee_id = ? AND hcm_location_id = ? AND leave_type = ?
            AND COALESCE(version, '') = COALESCE(?, '')
            AND occurred_at = ?`,
      )
      .get(
        input.hcmEmployeeId,
        input.hcmLocationId,
        input.leaveType,
        input.version ?? null,
        occurredAt,
      );
    if (dedupe) {
      return { applied: false, reason: 'duplicate-event' };
    }

    const employee = this.employees.findByHcmId(input.hcmEmployeeId);
    const location = this.employees.findLocationByHcmId(input.hcmLocationId);
    if (!employee || !location) {
      this.logger.warn(
        `Webhook for unknown employee/location: ${input.hcmEmployeeId}/${input.hcmLocationId}; queue full sync`,
      );
      return { applied: false, reason: 'unknown-employee-or-location' };
    }

    this.balances.applyHcmBalance({
      employeeId: employee.id,
      locationId: location.id,
      leaveType: input.leaveType,
      newHcmMinutes: input.balanceMinutes,
      hcmVersion: input.version ?? null,
      cause: 'HCM_WEBHOOK',
      actor: 'hcm',
      note: `webhook v=${input.version ?? '-'} occurredAt=${occurredAt}`,
    });

    this.db.db
      .prepare(
        `INSERT INTO hcm_webhook_events
           (hcm_employee_id, hcm_location_id, leave_type, version, occurred_at, received_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.hcmEmployeeId,
        input.hcmLocationId,
        input.leaveType,
        input.version ?? null,
        occurredAt,
        this.clock.nowIso(),
      );
    return { applied: true };
  }

  /** Reconcile a single employee against HCM realtime API. */
  async reconcileEmployee(employeeId: string): Promise<FullSyncResult> {
    const employee = this.employees.requireEmployee(employeeId);
    const result: FullSyncResult = {
      scanned: 0,
      updated: 0,
      unchanged: 0,
      newBalances: 0,
      newEmployees: 0,
      newLocations: 0,
    };
    const locations = this.db.db
      .prepare(`SELECT id, hcm_location_id FROM locations`)
      .all() as Array<{ id: string; hcm_location_id: string }>;

    for (const location of locations) {
      const balances = await this.hcm.getBalances({
        hcmEmployeeId: employee.hcm_employee_id,
        hcmLocationId: location.hcm_location_id,
      });
      for (const b of balances) {
        result.scanned += 1;
        const before = this.balances.get(employee.id, location.id, b.leaveType);
        const same =
          before &&
          before.hcm_balance_minutes === b.balanceMinutes &&
          before.hcm_version === b.version;
        if (same) {
          result.unchanged += 1;
          continue;
        }
        if (!before) result.newBalances += 1;
        else result.updated += 1;
        this.balances.applyHcmBalance({
          employeeId: employee.id,
          locationId: location.id,
          leaveType: b.leaveType,
          newHcmMinutes: b.balanceMinutes,
          hcmVersion: b.version,
          cause: 'HCM_RECONCILE',
          actor: 'system:sync',
          note: `reconcileEmployee(${employee.id})`,
        });
      }
    }
    return result;
  }

  /**
   * Pull the entire HCM corpus, paginated, and reconcile every balance.
   * Reservations are preserved; only `hcm_balance_minutes` is overwritten.
   * Creates employee/location stubs if HCM returns ones we don't know about.
   */
  async fullSync(): Promise<FullSyncResult> {
    const result: FullSyncResult = {
      scanned: 0,
      updated: 0,
      unchanged: 0,
      newBalances: 0,
      newEmployees: 0,
      newLocations: 0,
    };
    let cursor: string | null | undefined = null;
    do {
      const page = await this.hcm.listAllBalances({ cursor });
      for (const b of page.items) {
        result.scanned += 1;
        let employee = this.employees.findByHcmId(b.hcmEmployeeId);
        if (!employee) {
          employee = this.employees.upsertEmployee({
            hcmEmployeeId: b.hcmEmployeeId,
            name: b.hcmEmployeeId,
          });
          result.newEmployees += 1;
        }
        let location = this.employees.findLocationByHcmId(b.hcmLocationId);
        if (!location) {
          location = this.employees.upsertLocation({
            hcmLocationId: b.hcmLocationId,
            name: b.hcmLocationId,
          });
          result.newLocations += 1;
        }
        const before = this.balances.get(employee.id, location.id, b.leaveType);
        const same =
          before &&
          before.hcm_balance_minutes === b.balanceMinutes &&
          before.hcm_version === b.version;
        if (same) {
          result.unchanged += 1;
          continue;
        }
        if (!before) result.newBalances += 1;
        else result.updated += 1;
        this.balances.applyHcmBalance({
          employeeId: employee.id,
          locationId: location.id,
          leaveType: b.leaveType,
          newHcmMinutes: b.balanceMinutes,
          hcmVersion: b.version,
          cause: 'HCM_RECONCILE',
          actor: 'system:fullsync',
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return result;
  }
}
