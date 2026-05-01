import request from 'supertest';
import { E2eHarness, seed, startE2e } from './utils';

describe('Sync & webhooks (e2e)', () => {
  let h: E2eHarness;
  let server: any;

  beforeEach(async () => {
    h = await startE2e();
    server = h.app.getHttpServer();
  });

  afterEach(async () => {
    await h.close();
  });

  it('webhook applies a balance update over HTTP', async () => {
    const s = seed(h, { vacationMinutes: 4800 });
    const res = await request(server)
      .post('/webhooks/hcm/balance-updated')
      .send({
        hcmEmployeeId: s.hcmEmployeeId,
        hcmLocationId: s.hcmLocationId,
        leaveType: 'VACATION',
        balanceMinutes: 7680,
        version: 'wd-etag-1',
        occurredAt: '2026-04-30T15:00:00.000Z',
      });
    expect(res.status).toBe(202);
    expect(res.body.applied).toBe(true);

    const balRes = await request(server)
      .get(`/employees/${s.employeeId}/balances/${s.locationId}/VACATION`)
      .expect(200);
    expect(balRes.body.hcmBalanceMinutes).toBe(7680);
  });

  it('anniversary refresh: HCM bumps balance, in-flight reservation survives', async () => {
    const s = seed(h, { vacationMinutes: 4800 });
    const created = await request(server)
      .post('/time-off-requests')
      .send({
        employeeId: s.employeeId,
        locationId: s.locationId,
        leaveType: 'VACATION',
        startDate: '2026-06-10',
        endDate: '2026-06-10',
        durationMinutes: 480,
      })
      .expect(201);

    // Simulate HCM-side anniversary bonus (+8h = +480min) and webhook.
    h.hcm.bumpBalance(
      {
        hcmEmployeeId: s.hcmEmployeeId,
        hcmLocationId: s.hcmLocationId,
        leaveType: 'VACATION',
      },
      480,
    );
    await request(server)
      .post('/webhooks/hcm/balance-updated')
      .send({
        hcmEmployeeId: s.hcmEmployeeId,
        hcmLocationId: s.hcmLocationId,
        leaveType: 'VACATION',
        balanceMinutes: 4800 + 480,
        version: 'anniv-1',
      })
      .expect(202);

    const bal = await request(server)
      .get(`/employees/${s.employeeId}/balances/${s.locationId}/VACATION`)
      .expect(200);
    expect(bal.body.hcmBalanceMinutes).toBe(5280);
    expect(bal.body.reservedMinutes).toBe(480);
    expect(bal.body.availableMinutes).toBe(4800);

    // Approve & flush — HCM should still file because it has 5280 minutes.
    await request(server)
      .post(`/time-off-requests/${created.body.id}/approve`)
      .send({ managerId: 'mgr-1' })
      .expect(200);
    await request(server).post('/admin/outbox/flush').expect(200);

    const final = await request(server)
      .get(`/employees/${s.employeeId}/balances/${s.locationId}/VACATION`)
      .expect(200);
    expect(final.body.hcmBalanceMinutes).toBe(4800);
    expect(final.body.reservedMinutes).toBe(0);
  });

  it('full sync repairs missed-webhook drift', async () => {
    const s = seed(h, { vacationMinutes: 4800 });
    // HR changes balance directly in HCM; webhook is dropped on the floor.
    h.hcm.setBalance({
      hcmEmployeeId: s.hcmEmployeeId,
      hcmLocationId: s.hcmLocationId,
      leaveType: 'VACATION',
      balanceMinutes: 9000,
    });
    // Local view is still 4800.
    const before = await request(server)
      .get(`/employees/${s.employeeId}/balances/${s.locationId}/VACATION`)
      .expect(200);
    expect(before.body.hcmBalanceMinutes).toBe(4800);

    const sync = await request(server).post('/admin/sync/full').expect(200);
    expect(sync.body.scanned).toBeGreaterThan(0);

    const after = await request(server)
      .get(`/employees/${s.employeeId}/balances/${s.locationId}/VACATION`)
      .expect(200);
    expect(after.body.hcmBalanceMinutes).toBe(9000);
  });

  it('webhook for unknown ids is ignored gracefully', async () => {
    const res = await request(server)
      .post('/webhooks/hcm/balance-updated')
      .send({
        hcmEmployeeId: 'unknown',
        hcmLocationId: 'unknown',
        leaveType: 'VACATION',
        balanceMinutes: 480,
      })
      .expect(202);
    expect(res.body.applied).toBe(false);
  });
});
