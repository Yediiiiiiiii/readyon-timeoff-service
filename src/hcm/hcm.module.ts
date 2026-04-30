import { Global, Module } from '@nestjs/common';
import { HcmClient } from './hcm-client';
import { MockHcmService } from './mock-hcm.service';

/**
 * Global so that `HcmClient` injection works everywhere.
 *
 * Production wiring would replace `MockHcmService` with a Workday/SAP adapter
 * via `useClass`/`useFactory` based on env (`HCM_PROVIDER=workday|sap|mock`).
 */
@Global()
@Module({
  providers: [
    MockHcmService,
    {
      provide: HcmClient,
      useExisting: MockHcmService,
    },
  ],
  exports: [HcmClient, MockHcmService],
})
export class HcmModule {}
