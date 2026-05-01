import { Injectable } from '@nestjs/common';

/**
 * Wall-clock abstraction so tests can advance time deterministically.
 * Always returns ISO-8601 UTC strings to keep the rest of the code stringly-typed.
 */
@Injectable()
export class Clock {
  private fixed: Date | null = null;

  now(): Date {
    return this.fixed ? new Date(this.fixed.getTime()) : new Date();
  }

  nowIso(): string {
    return this.now().toISOString();
  }

  /** Test-only: pin the clock. */
  setForTests(date: Date | null) {
    this.fixed = date;
  }
}
