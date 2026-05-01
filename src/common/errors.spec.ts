import { HttpStatus } from '@nestjs/common';
import { DomainError } from './errors';

describe('DomainError factories', () => {
  it.each([
    [
      'insufficientBalance',
      DomainError.insufficientBalance('x'),
      HttpStatus.CONFLICT,
      'INSUFFICIENT_BALANCE',
    ],
    [
      'employeeNotFound',
      DomainError.employeeNotFound('e'),
      HttpStatus.NOT_FOUND,
      'EMPLOYEE_NOT_FOUND',
    ],
    [
      'locationNotFound',
      DomainError.locationNotFound('l'),
      HttpStatus.NOT_FOUND,
      'LOCATION_NOT_FOUND',
    ],
    [
      'balanceNotFound',
      DomainError.balanceNotFound('b'),
      HttpStatus.NOT_FOUND,
      'BALANCE_NOT_FOUND',
    ],
    [
      'requestNotFound',
      DomainError.requestNotFound('r'),
      HttpStatus.NOT_FOUND,
      'REQUEST_NOT_FOUND',
    ],
    [
      'illegalTransition',
      DomainError.illegalTransition('A', 'B'),
      HttpStatus.CONFLICT,
      'ILLEGAL_TRANSITION',
    ],
    [
      'idempotencyReplay',
      DomainError.idempotencyReplay('m'),
      HttpStatus.CONFLICT,
      'IDEMPOTENCY_REPLAY',
    ],
    [
      'invalidInput',
      DomainError.invalidInput('n'),
      HttpStatus.UNPROCESSABLE_ENTITY,
      'INVALID_INPUT',
    ],
    [
      'hcmUnavailable',
      DomainError.hcmUnavailable('u'),
      HttpStatus.SERVICE_UNAVAILABLE,
      'HCM_UNAVAILABLE',
    ],
    [
      'hcmRejected',
      DomainError.hcmRejected('r'),
      HttpStatus.CONFLICT,
      'HCM_REJECTED',
    ],
    [
      'concurrencyConflict',
      DomainError.concurrencyConflict(),
      HttpStatus.CONFLICT,
      'CONCURRENCY_CONFLICT',
    ],
  ] as const)(
    '%s factory has correct status and code',
    (_, err, status, code) => {
      expect(err.getStatus()).toBe(status);
      expect((err.getResponse() as { code: string }).code).toBe(code);
      expect(err.message.length).toBeGreaterThan(0);
    },
  );
});
