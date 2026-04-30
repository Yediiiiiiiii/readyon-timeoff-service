import { Injectable, Logger } from '@nestjs/common';
import {
  HcmBalance,
  HcmClient,
  HcmFileRequest,
  HcmFileResponse,
  HcmPermanentError,
  HcmTransientError,
} from './hcm-client';

/**
 * HTTP adapter for any HCM that speaks the same REST shape as our Mock HCM.
 * Real Workday/SAP adapters live next to this one and translate to the
 * vendor-specific payload shape.
 *
 * Treats:
 *   - 5xx and network errors as transient (outbox will retry).
 *   - 4xx as permanent (request will FAIL).
 */
@Injectable()
export class HttpHcmClient extends HcmClient {
  private readonly logger = new Logger(HttpHcmClient.name);

  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly baseUrl: string,
    fetchImpl?: typeof fetch,
    private readonly timeoutMs: number = 5000,
  ) {
    super();
    this.fetchImpl =
      fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  async getBalances(input: {
    hcmEmployeeId: string;
    hcmLocationId: string;
  }): Promise<HcmBalance[]> {
    return await this.request<HcmBalance[]>(
      'POST',
      '/mock-hcm/balances/lookup',
      input,
    );
  }

  async listAllBalances(input: {
    cursor?: string | null;
  }): Promise<{ items: HcmBalance[]; nextCursor: string | null }> {
    const qs = input.cursor
      ? `?cursor=${encodeURIComponent(input.cursor)}`
      : '';
    return await this.request<{
      items: HcmBalance[];
      nextCursor: string | null;
    }>('GET', `/mock-hcm/balances${qs}`);
  }

  async fileTimeOff(input: HcmFileRequest): Promise<HcmFileResponse> {
    return await this.request<HcmFileResponse>(
      'POST',
      '/mock-hcm/timeoff',
      input,
    );
  }

  async cancelTimeOff(input: { hcmRequestId: string }): Promise<void> {
    await this.request<void>(
      'DELETE',
      `/mock-hcm/timeoff/${encodeURIComponent(input.hcmRequestId)}`,
    );
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = this.baseUrl.replace(/\/$/, '') + path;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        signal: ctrl.signal,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new HcmTransientError(
        `network error calling HCM ${method} ${path}: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 500 || res.status === 408 || res.status === 429) {
      const text = await res.text().catch(() => '');
      throw new HcmTransientError(
        `HCM ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    if (res.status >= 400) {
      const text = await res.text().catch(() => '');
      throw new HcmPermanentError(
        `HCM ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    if (res.status === 204) return undefined as unknown as T;
    return (await res.json()) as T;
  }
}
