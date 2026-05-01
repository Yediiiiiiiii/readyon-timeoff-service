import { HttpException, HttpStatus } from '@nestjs/common';

export type DomainErrorCode =
  | 'INSUFFICIENT_BALANCE'
  | 'EMPLOYEE_NOT_FOUND'
  | 'LOCATION_NOT_FOUND'
  | 'BALANCE_NOT_FOUND'
  | 'REQUEST_NOT_FOUND'
  | 'ILLEGAL_TRANSITION'
  | 'IDEMPOTENCY_REPLAY'
  | 'INVALID_INPUT'
  | 'HCM_UNAVAILABLE'
  | 'HCM_REJECTED'
  | 'CONCURRENCY_CONFLICT';

export class DomainError extends HttpException {
  constructor(
    public readonly code: DomainErrorCode,
    public readonly title: string,
    detail: string,
    status: HttpStatus,
  ) {
    super(
      {
        type: `https://readyon.dev/errors/${code.toLowerCase()}`,
        title,
        status,
        code,
        detail,
        message: `${title}: ${detail}`,
      },
      status,
    );
    this.message = `${title}: ${detail}`;
  }

  static insufficientBalance(detail: string) {
    return new DomainError(
      'INSUFFICIENT_BALANCE',
      'Insufficient balance',
      detail,
      HttpStatus.CONFLICT,
    );
  }

  static employeeNotFound(id: string) {
    return new DomainError(
      'EMPLOYEE_NOT_FOUND',
      'Employee not found',
      `Employee ${id} not found`,
      HttpStatus.NOT_FOUND,
    );
  }

  static locationNotFound(id: string) {
    return new DomainError(
      'LOCATION_NOT_FOUND',
      'Location not found',
      `Location ${id} not found`,
      HttpStatus.NOT_FOUND,
    );
  }

  static balanceNotFound(detail: string) {
    return new DomainError(
      'BALANCE_NOT_FOUND',
      'Balance not found',
      detail,
      HttpStatus.NOT_FOUND,
    );
  }

  static requestNotFound(id: string) {
    return new DomainError(
      'REQUEST_NOT_FOUND',
      'Time-off request not found',
      `Request ${id} not found`,
      HttpStatus.NOT_FOUND,
    );
  }

  static illegalTransition(from: string, to: string) {
    return new DomainError(
      'ILLEGAL_TRANSITION',
      'Illegal state transition',
      `Cannot transition request from ${from} to ${to}`,
      HttpStatus.CONFLICT,
    );
  }

  static idempotencyReplay(detail: string) {
    return new DomainError(
      'IDEMPOTENCY_REPLAY',
      'Idempotency-Key replayed with different body',
      detail,
      HttpStatus.CONFLICT,
    );
  }

  static invalidInput(detail: string) {
    return new DomainError(
      'INVALID_INPUT',
      'Invalid input',
      detail,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  static hcmUnavailable(detail: string) {
    return new DomainError(
      'HCM_UNAVAILABLE',
      'HCM unavailable',
      detail,
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  static hcmRejected(detail: string) {
    return new DomainError(
      'HCM_REJECTED',
      'HCM rejected the operation',
      detail,
      HttpStatus.CONFLICT,
    );
  }

  static concurrencyConflict() {
    return new DomainError(
      'CONCURRENCY_CONFLICT',
      'Concurrent modification',
      'The resource changed concurrently; retry the operation',
      HttpStatus.CONFLICT,
    );
  }
}
