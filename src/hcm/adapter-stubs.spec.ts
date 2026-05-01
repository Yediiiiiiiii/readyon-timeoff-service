import { HcmPermanentError } from './hcm-client';
import { SapHcmClient } from './sap-hcm.client';
import { WorkdayHcmClient } from './workday-hcm.client';

describe('Vendor adapter stubs', () => {
  describe('WorkdayHcmClient', () => {
    it('refuses to construct without credentials', () => {
      expect(() => new WorkdayHcmClient('', '')).toThrow(/tenantUrl|bearer/i);
    });

    it('throws HcmPermanentError until implemented', async () => {
      const c = new WorkdayHcmClient('https://wd.example.com', 'tok');
      await expect(
        c.getBalances({ hcmEmployeeId: 'a', hcmLocationId: 'b' }),
      ).rejects.toBeInstanceOf(HcmPermanentError);
      await expect(c.listAllBalances({ cursor: null })).rejects.toBeInstanceOf(
        HcmPermanentError,
      );
      await expect(
        c.fileTimeOff({
          requestId: 'r',
          hcmEmployeeId: 'a',
          hcmLocationId: 'b',
          leaveType: 'VACATION',
          startDate: '2026-01-01',
          endDate: '2026-01-01',
          durationMinutes: 60,
        }),
      ).rejects.toBeInstanceOf(HcmPermanentError);
      await expect(
        c.cancelTimeOff({ hcmRequestId: 'r' }),
      ).rejects.toBeInstanceOf(HcmPermanentError);
    });
  });

  describe('SapHcmClient', () => {
    it('refuses to construct without credentials', () => {
      expect(() => new SapHcmClient('', '', '')).toThrow(/odata|client/i);
    });

    it('throws HcmPermanentError until implemented', async () => {
      const c = new SapHcmClient('https://sap.example.com', 'cid', 'csec');
      await expect(
        c.getBalances({ hcmEmployeeId: 'a', hcmLocationId: 'b' }),
      ).rejects.toBeInstanceOf(HcmPermanentError);
      await expect(c.listAllBalances({ cursor: null })).rejects.toBeInstanceOf(
        HcmPermanentError,
      );
      await expect(
        c.fileTimeOff({
          requestId: 'r',
          hcmEmployeeId: 'a',
          hcmLocationId: 'b',
          leaveType: 'VACATION',
          startDate: '2026-01-01',
          endDate: '2026-01-01',
          durationMinutes: 60,
        }),
      ).rejects.toBeInstanceOf(HcmPermanentError);
      await expect(
        c.cancelTimeOff({ hcmRequestId: 'r' }),
      ).rejects.toBeInstanceOf(HcmPermanentError);
    });
  });
});
