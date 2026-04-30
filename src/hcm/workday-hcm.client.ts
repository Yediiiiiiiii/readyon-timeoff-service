import { Logger } from '@nestjs/common';
import {
  HcmBalance,
  HcmClient,
  HcmFileRequest,
  HcmFileResponse,
  HcmPermanentError,
} from './hcm-client';

/**
 * Workday adapter — stub. Demonstrates how a real vendor implementation
 * plugs into the HcmClient abstraction.
 *
 * In production this would translate ReadyOn's neutral payloads to
 * Workday's WID-keyed SOAP/REST and back. The unit tests for the
 * Time-Off and Sync services don't change at all — they're written
 * against the `HcmClient` interface.
 */
export class WorkdayHcmClient extends HcmClient {
  private readonly logger = new Logger(WorkdayHcmClient.name);

  constructor(
    private readonly tenantUrl: string,
    private readonly bearerToken: string,
  ) {
    super();
    if (!tenantUrl || !bearerToken) {
      throw new Error(
        'WorkdayHcmClient requires tenantUrl and bearerToken; see deployment runbook',
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getBalances(_input: {
    hcmEmployeeId: string;
    hcmLocationId: string;
  }): Promise<HcmBalance[]> {
    this.logger.warn('WorkdayHcmClient.getBalances not yet implemented');
    throw new HcmPermanentError(
      'Workday adapter is a stub; implement before production deploy',
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listAllBalances(_input: {
    cursor?: string | null;
  }): Promise<{ items: HcmBalance[]; nextCursor: string | null }> {
    throw new HcmPermanentError(
      'Workday adapter is a stub; implement before production deploy',
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async fileTimeOff(_input: HcmFileRequest): Promise<HcmFileResponse> {
    throw new HcmPermanentError(
      'Workday adapter is a stub; implement before production deploy',
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async cancelTimeOff(_input: { hcmRequestId: string }): Promise<void> {
    throw new HcmPermanentError(
      'Workday adapter is a stub; implement before production deploy',
    );
  }
}
