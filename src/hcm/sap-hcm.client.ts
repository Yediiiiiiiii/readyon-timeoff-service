import { Logger } from '@nestjs/common';
import {
  HcmBalance,
  HcmClient,
  HcmFileRequest,
  HcmFileResponse,
  HcmPermanentError,
} from './hcm-client';

/**
 * SAP SuccessFactors adapter — stub.
 *
 * The role of this file is to demonstrate that switching vendors is
 * a *new file* implementing `HcmClient`, not a rewrite of any business
 * logic. ReadyOn's Time-Off, Sync, and Outbox services are fully
 * adapter-agnostic.
 */
export class SapHcmClient extends HcmClient {
  private readonly logger = new Logger(SapHcmClient.name);

  constructor(
    private readonly oDataBaseUrl: string,
    private readonly oauthClientId: string,
    private readonly oauthClientSecret: string,
  ) {
    super();
    if (!oDataBaseUrl || !oauthClientId || !oauthClientSecret) {
      throw new Error(
        'SapHcmClient requires oDataBaseUrl, oauthClientId, oauthClientSecret',
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getBalances(_input: {
    hcmEmployeeId: string;
    hcmLocationId: string;
  }): Promise<HcmBalance[]> {
    this.logger.warn('SapHcmClient.getBalances not yet implemented');
    throw new HcmPermanentError(
      'SAP adapter is a stub; implement before production deploy',
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listAllBalances(_input: {
    cursor?: string | null;
  }): Promise<{ items: HcmBalance[]; nextCursor: string | null }> {
    throw new HcmPermanentError(
      'SAP adapter is a stub; implement before production deploy',
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async fileTimeOff(_input: HcmFileRequest): Promise<HcmFileResponse> {
    throw new HcmPermanentError(
      'SAP adapter is a stub; implement before production deploy',
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async cancelTimeOff(_input: { hcmRequestId: string }): Promise<void> {
    throw new HcmPermanentError(
      'SAP adapter is a stub; implement before production deploy',
    );
  }
}
