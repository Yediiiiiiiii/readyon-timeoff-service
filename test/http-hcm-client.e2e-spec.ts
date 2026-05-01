import { HttpHcmClient } from '../src/hcm/http-hcm.client';
import { HcmPermanentError, HcmTransientError } from '../src/hcm/hcm-client';
import { E2eHarness, startE2e } from './utils';

/**
 * Exercises HttpHcmClient against the running mock-hcm HTTP controller.
 * This is the strongest proof that the abstraction works end-to-end:
 * a real adapter, real HTTP, real wire protocol, with deterministic
 * fault injection.
 */
describe('HttpHcmClient against Mock HCM HTTP (e2e)', () => {
  let h: E2eHarness;
  let client: HttpHcmClient;
  let baseUrl: string;

  beforeEach(async () => {
    h = await startE2e();
    baseUrl = h.url;
    client = new HttpHcmClient(baseUrl);
    h.hcm.seedBalance({
      hcmEmployeeId: 'wd-x',
      hcmLocationId: 'loc-x',
      leaveType: 'VACATION',
      balanceMinutes: 4800,
    });
  });
  afterEach(async () => {
    await h.close();
  });

  it('round-trips getBalances and listAllBalances', async () => {
    const single = await client.getBalances({
      hcmEmployeeId: 'wd-x',
      hcmLocationId: 'loc-x',
    });
    expect(single).toHaveLength(1);
    expect(single[0].balanceMinutes).toBe(4800);

    const all = await client.listAllBalances({ cursor: null });
    expect(all.items.length).toBe(1);
    expect(all.nextCursor).toBeNull();
  });

  it('files and cancels time-off via HTTP', async () => {
    const filed = await client.fileTimeOff({
      requestId: 'http-1',
      hcmEmployeeId: 'wd-x',
      hcmLocationId: 'loc-x',
      leaveType: 'VACATION',
      startDate: '2026-06-01',
      endDate: '2026-06-01',
      durationMinutes: 240,
    });
    expect(filed.hcmRequestId).toMatch(/^hcm-req-/);
    await client.cancelTimeOff({ hcmRequestId: filed.hcmRequestId });
  });

  it('translates 503 responses to HcmTransientError', async () => {
    h.hcm.failures.fileTimeOffTransientUntil = 1;
    await expect(
      client.fileTimeOff({
        requestId: 'http-tx',
        hcmEmployeeId: 'wd-x',
        hcmLocationId: 'loc-x',
        leaveType: 'VACATION',
        startDate: '2026-06-01',
        endDate: '2026-06-01',
        durationMinutes: 60,
      }),
    ).rejects.toBeInstanceOf(HcmTransientError);
  });

  it('translates 4xx responses to HcmPermanentError', async () => {
    h.hcm.failures.fileTimeOffPermanent = true;
    await expect(
      client.fileTimeOff({
        requestId: 'http-perm',
        hcmEmployeeId: 'wd-x',
        hcmLocationId: 'loc-x',
        leaveType: 'VACATION',
        startDate: '2026-06-01',
        endDate: '2026-06-01',
        durationMinutes: 60,
      }),
    ).rejects.toBeInstanceOf(HcmPermanentError);
  });

  it('translates network failures (unreachable host) to HcmTransientError', async () => {
    const dead = new HttpHcmClient('http://127.0.0.1:1', undefined, 250);
    await expect(
      dead.getBalances({ hcmEmployeeId: 'x', hcmLocationId: 'y' }),
    ).rejects.toBeInstanceOf(HcmTransientError);
  });

  it('respects request timeout', async () => {
    const slow = new HttpHcmClient(
      baseUrl,
      ((url: any, init?: any) => {
        return new Promise((_, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          ),
        );
      }) as unknown as typeof fetch,
      50,
    );
    await expect(
      slow.getBalances({ hcmEmployeeId: 'x', hcmLocationId: 'y' }),
    ).rejects.toBeInstanceOf(HcmTransientError);
  });
});
