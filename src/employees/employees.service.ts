import { Injectable } from '@nestjs/common';
import { randomUUID as uuid } from 'crypto';
import { DbService } from '../db/db.service';
import { Clock } from '../common/clock';
import { DomainError } from '../common/errors';

export interface Employee {
  id: string;
  hcm_employee_id: string;
  name: string;
  created_at: string;
}

export interface Location {
  id: string;
  hcm_location_id: string;
  name: string;
}

@Injectable()
export class EmployeesService {
  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
  ) {}

  upsertEmployee(input: {
    hcmEmployeeId: string;
    name: string;
    id?: string;
  }): Employee {
    const existing = this.findByHcmId(input.hcmEmployeeId);
    if (existing) {
      if (existing.name !== input.name) {
        this.db.db
          .prepare(`UPDATE employees SET name = ? WHERE id = ?`)
          .run(input.name, existing.id);
        return { ...existing, name: input.name };
      }
      return existing;
    }
    const id = input.id ?? uuid();
    const now = this.clock.nowIso();
    this.db.db
      .prepare(
        `INSERT INTO employees (id, hcm_employee_id, name, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, input.hcmEmployeeId, input.name, now);
    return {
      id,
      hcm_employee_id: input.hcmEmployeeId,
      name: input.name,
      created_at: now,
    };
  }

  upsertLocation(input: {
    hcmLocationId: string;
    name: string;
    id?: string;
  }): Location {
    const existing = this.findLocationByHcmId(input.hcmLocationId);
    if (existing) return existing;
    const id = input.id ?? uuid();
    this.db.db
      .prepare(
        `INSERT INTO locations (id, hcm_location_id, name) VALUES (?, ?, ?)`,
      )
      .run(id, input.hcmLocationId, input.name);
    return {
      id,
      hcm_location_id: input.hcmLocationId,
      name: input.name,
    };
  }

  findById(id: string): Employee | null {
    const row = this.db.db
      .prepare(`SELECT * FROM employees WHERE id = ?`)
      .get(id) as Employee | undefined;
    return row ?? null;
  }

  findByHcmId(hcmId: string): Employee | null {
    const row = this.db.db
      .prepare(`SELECT * FROM employees WHERE hcm_employee_id = ?`)
      .get(hcmId) as Employee | undefined;
    return row ?? null;
  }

  findLocationById(id: string): Location | null {
    const row = this.db.db
      .prepare(`SELECT * FROM locations WHERE id = ?`)
      .get(id) as Location | undefined;
    return row ?? null;
  }

  findLocationByHcmId(hcmId: string): Location | null {
    const row = this.db.db
      .prepare(`SELECT * FROM locations WHERE hcm_location_id = ?`)
      .get(hcmId) as Location | undefined;
    return row ?? null;
  }

  requireEmployee(id: string): Employee {
    const e = this.findById(id);
    if (!e) throw DomainError.employeeNotFound(id);
    return e;
  }

  requireLocation(id: string): Location {
    const l = this.findLocationById(id);
    if (!l) throw DomainError.locationNotFound(id);
    return l;
  }

  listEmployees(): Employee[] {
    return this.db.db
      .prepare(`SELECT * FROM employees ORDER BY created_at`)
      .all() as Employee[];
  }
}
