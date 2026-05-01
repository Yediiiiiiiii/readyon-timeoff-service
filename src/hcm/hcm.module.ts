import { DynamicModule, Global, Module } from '@nestjs/common';
import { HcmClient } from './hcm-client';
import { HttpHcmClient } from './http-hcm.client';
import { MockHcmController } from './mock-hcm.controller';
import { MockHcmService } from './mock-hcm.service';
import { SapHcmClient } from './sap-hcm.client';
import { WorkdayHcmClient } from './workday-hcm.client';

export type HcmProvider = 'mock' | 'http' | 'workday' | 'sap';

export interface HcmModuleOptions {
  provider?: HcmProvider;
  baseUrl?: string;
  enableMockController?: boolean;
}

/**
 * `HcmClient` is selected at boot from `HCM_PROVIDER`:
 *
 *   mock     -> in-process MockHcmService (default; used by tests & dev)
 *   http     -> HttpHcmClient pointing at HCM_BASE_URL (HTTP wire-protocol)
 *   workday  -> WorkdayHcmClient (stub)
 *   sap      -> SapHcmClient (stub)
 *
 * When provider != 'mock', the in-process MockHcmService is still
 * registered (cheap and self-contained) so the mock-hcm controller can
 * still be mounted in dev.
 */
@Global()
@Module({})
export class HcmModule {
  static forRoot(options: HcmModuleOptions = {}): DynamicModule {
    const provider: HcmProvider =
      options.provider ?? (process.env.HCM_PROVIDER as HcmProvider) ?? 'mock';
    const baseUrl =
      options.baseUrl ?? process.env.HCM_BASE_URL ?? 'http://localhost:3000';
    const enableMockController =
      options.enableMockController ??
      (process.env.ENABLE_MOCK_HCM ?? '1') === '1';

    const controllers = enableMockController ? [MockHcmController] : [];

    return {
      module: HcmModule,
      controllers,
      providers: [
        MockHcmService,
        {
          provide: HcmClient,
          useFactory: (mock: MockHcmService): HcmClient => {
            if (provider === 'http') return new HttpHcmClient(baseUrl);
            if (provider === 'workday') {
              return new WorkdayHcmClient(
                process.env.WORKDAY_TENANT_URL ?? '',
                process.env.WORKDAY_BEARER_TOKEN ?? '',
              );
            }
            if (provider === 'sap') {
              return new SapHcmClient(
                process.env.SAP_ODATA_BASE_URL ?? '',
                process.env.SAP_OAUTH_CLIENT_ID ?? '',
                process.env.SAP_OAUTH_CLIENT_SECRET ?? '',
              );
            }
            return mock;
          },
          inject: [MockHcmService],
        },
      ],
      exports: [HcmClient, MockHcmService],
    };
  }
}
