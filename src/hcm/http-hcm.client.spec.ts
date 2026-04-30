import { HttpHcmClient } from './http-hcm.client';
import { HcmPermanentError, HcmTransientError } from './hcm-client';

function makeFetch(
  status: number,
  body: unknown,
  contentType = 'application/json',
): typeof fetch {
  return (_url: string) => {
    // 204/205 cannot have a body per spec.
    const init: ResponseInit = {
      status,
      headers:
        status === 204 || status === 205
          ? undefined
          : { 'content-type': contentType },
    };
    const payload =
      status === 204 || status === 205
        ? null
        : typeof body === 'string'
          ? body
          : JSON.stringify(body);
    return Promise.resolve(new Response(payload, init));
  };
}

describe('HttpHcmClient (unit)', () => {
  it('returns parsed body on 2xx', async () => {
    const c = new HttpHcmClient(
      'http://hcm',
      makeFetch(200, [{ leaveType: 'VACATION', balanceMinutes: 480 }]),
    );
    const out = await c.getBalances({
      hcmEmployeeId: 'a',
      hcmLocationId: 'b',
    });
    expect(out[0].balanceMinutes).toBe(480);
  });

  it('classifies 5xx as transient', async () => {
    const c = new HttpHcmClient('http://hcm', makeFetch(503, 'down'));
    await expect(
      c.getBalances({ hcmEmployeeId: 'a', hcmLocationId: 'b' }),
    ).rejects.toBeInstanceOf(HcmTransientError);
  });

  it('classifies 408 / 429 as transient', async () => {
    const c1 = new HttpHcmClient('http://hcm', makeFetch(408, 'timeout'));
    await expect(
      c1.getBalances({ hcmEmployeeId: 'a', hcmLocationId: 'b' }),
    ).rejects.toBeInstanceOf(HcmTransientError);
    const c2 = new HttpHcmClient('http://hcm', makeFetch(429, 'limited'));
    await expect(
      c2.getBalances({ hcmEmployeeId: 'a', hcmLocationId: 'b' }),
    ).rejects.toBeInstanceOf(HcmTransientError);
  });

  it('classifies 4xx as permanent', async () => {
    const c = new HttpHcmClient('http://hcm', makeFetch(400, 'bad'));
    await expect(
      c.getBalances({ hcmEmployeeId: 'a', hcmLocationId: 'b' }),
    ).rejects.toBeInstanceOf(HcmPermanentError);
  });

  it('classifies fetch throws as transient', async () => {
    const c = new HttpHcmClient('http://hcm', () =>
      Promise.reject(new Error('ECONNREFUSED')),
    );
    await expect(
      c.getBalances({ hcmEmployeeId: 'a', hcmLocationId: 'b' }),
    ).rejects.toBeInstanceOf(HcmTransientError);
  });

  it('handles 204 (no content) for cancel', async () => {
    const c = new HttpHcmClient('http://hcm', makeFetch(204, ''));
    await expect(
      c.cancelTimeOff({ hcmRequestId: 'x' }),
    ).resolves.toBeUndefined();
  });

  it('strips trailing slash from baseUrl', async () => {
    let observedUrl = '';
    const fetchImpl = (url: string) => {
      observedUrl = url;
      return Promise.resolve(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
    const c = new HttpHcmClient('http://hcm/', fetchImpl);
    await c.getBalances({ hcmEmployeeId: 'a', hcmLocationId: 'b' });
    expect(observedUrl).toBe('http://hcm/mock-hcm/balances/lookup');
  });
});
