import { buildTestHarness, TestHarness } from '../test-utils';
import { IdempotencyService } from './idempotency.service';

describe('IdempotencyService', () => {
  let h: TestHarness;
  let svc: IdempotencyService;

  beforeEach(async () => {
    h = await buildTestHarness();
    svc = h.module.get(IdempotencyService);
  });

  afterEach(async () => {
    await h.close();
  });

  it('returns null for unknown keys', () => {
    expect(svc.lookup('nope', '/r', { a: 1 })).toBeNull();
  });

  it('round-trips a stored response', () => {
    svc.store('k1', '/r', { a: 1, b: 2 }, { status: 201, body: { id: 'x' } });
    const got = svc.lookup<{ id: string }>('k1', '/r', { b: 2, a: 1 });
    expect(got).toEqual({ status: 201, body: { id: 'x' } });
  });

  it('detects body drift on replay', () => {
    svc.store('k2', '/r', { a: 1 }, { status: 201, body: 'ok' });
    expect(() => svc.lookup('k2', '/r', { a: 2 })).toThrow(
      /IDEMPOTENCY_REPLAY|differ/i,
    );
  });

  it('detects route drift on replay', () => {
    svc.store('k3', '/r1', { a: 1 }, { status: 201, body: 'ok' });
    expect(() => svc.lookup('k3', '/r2', { a: 1 })).toThrow(/route/i);
  });

  it('canonicalizes nested object keys', () => {
    const a = { x: { p: 1, q: 2 }, y: [1, 2] };
    const b = { y: [1, 2], x: { q: 2, p: 1 } };
    expect(svc.hashBody(a)).toEqual(svc.hashBody(b));
  });
});
