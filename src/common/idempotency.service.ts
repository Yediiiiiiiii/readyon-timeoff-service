import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { DbService } from '../db/db.service';
import { Clock } from './clock';
import { DomainError } from './errors';

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalize(v)).join(',') + ']';
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return (
    '{' +
    entries
      .map(([k, v]) => JSON.stringify(k) + ':' + canonicalize(v))
      .join(',') +
    '}'
  );
}

export interface IdempotentResult<T> {
  status: number;
  body: T;
}

@Injectable()
export class IdempotencyService {
  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
  ) {}

  /**
   * Hashes the canonical request payload to detect "same key, different body" replays.
   * Object keys are sorted recursively so equivalent payloads hash identically.
   */
  hashBody(body: unknown): string {
    return createHash('sha256').update(canonicalize(body)).digest('hex');
  }

  /**
   * Look up an idempotency record. If present and the body hash matches,
   * return the stored response. If present but body differs, throw IDEMPOTENCY_REPLAY.
   * If absent, return null.
   */
  lookup<T>(
    key: string,
    route: string,
    body: unknown,
  ): IdempotentResult<T> | null {
    const row = this.db.db
      .prepare(
        `SELECT route, request_hash, response_status, response_body
           FROM idempotency_keys WHERE key = ?`,
      )
      .get(key) as
      | {
          route: string;
          request_hash: string;
          response_status: number;
          response_body: string;
        }
      | undefined;
    if (!row) return null;
    if (row.route !== route) {
      throw DomainError.idempotencyReplay(
        `Idempotency-Key was previously used for route ${row.route}`,
      );
    }
    const hash = this.hashBody(body);
    if (row.request_hash !== hash) {
      throw DomainError.idempotencyReplay(
        'Body differs from the original request for this Idempotency-Key',
      );
    }
    return {
      status: row.response_status,
      body: JSON.parse(row.response_body) as T,
    };
  }

  store<T>(
    key: string,
    route: string,
    body: unknown,
    response: IdempotentResult<T>,
  ): void {
    this.db.db
      .prepare(
        `INSERT OR REPLACE INTO idempotency_keys
           (key, route, request_hash, response_status, response_body, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        key,
        route,
        this.hashBody(body),
        response.status,
        JSON.stringify(response.body),
        this.clock.nowIso(),
      );
  }
}
