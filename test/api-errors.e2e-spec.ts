import request from 'supertest';
import { E2eHarness, seed, startE2e } from './utils';

describe('API error paths (e2e)', () => {
  let h: E2eHarness;
  let server: any;

  beforeEach(async () => {
    h = await startE2e();
    server = h.app.getHttpServer();
  });
  afterEach(async () => {
    await h.close();
  });

  it('GET /employees/:id/balances returns 404 for unknown employee', async () => {
    const res = await request(server).get('/employees/nope/balances');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('EMPLOYEE_NOT_FOUND');
  });

  it('GET /employees/:id/balances/:loc/:type returns 404 for unknown location', async () => {
    seed(h);
    const res = await request(server).get(
      '/employees/emp-1/balances/nope/VACATION',
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('LOCATION_NOT_FOUND');
  });

  it('GET /time-off-requests/:id returns 404 for unknown request', async () => {
    const res = await request(server).get('/time-off-requests/nope');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('REQUEST_NOT_FOUND');
  });

  it('cancel of CANCELLED is idempotent', async () => {
    const s = seed(h);
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
    await request(server)
      .post(`/time-off-requests/${created.body.id}/cancel`)
      .send({})
      .expect(200);
    await request(server)
      .post(`/time-off-requests/${created.body.id}/cancel`)
      .send({})
      .expect(200);
  });

  it('cancel of FAILED returns ILLEGAL_TRANSITION', async () => {
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
    await request(server)
      .post(`/time-off-requests/${created.body.id}/approve`)
      .send({ managerId: 'mgr-1' })
      .expect(200);
    h.hcm.failures.fileTimeOffPermanent = true;
    await h.outbox.flushOnce();
    expect(h.timeOff.get(created.body.id)!.status).toBe('FAILED');
    const cancel = await request(server)
      .post(`/time-off-requests/${created.body.id}/cancel`)
      .send({});
    expect(cancel.status).toBe(409);
    expect(cancel.body.code).toBe('ILLEGAL_TRANSITION');
  });

  it('list employee requests via HTTP', async () => {
    const s = seed(h);
    await request(server)
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
    const list = await request(server)
      .get(`/employees/${s.employeeId}/time-off-requests`)
      .expect(200);
    expect(list.body.items.length).toBe(1);
  });

  it('admin/sync/employee/:id reconciles only that employee', async () => {
    const a = seed(h, { employeeId: 'a', hcmEmployeeId: 'wd-a' });
    h.hcm.setBalance({
      hcmEmployeeId: a.hcmEmployeeId,
      hcmLocationId: a.hcmLocationId,
      leaveType: 'VACATION',
      balanceMinutes: 6000,
    });
    const r = await request(server)
      .post(`/admin/sync/employee/${a.employeeId}`)
      .expect(200);
    expect(r.body.scanned).toBeGreaterThan(0);
    const v = await request(server)
      .get(`/employees/${a.employeeId}/balances/${a.locationId}/VACATION`)
      .expect(200);
    expect(v.body.hcmBalanceMinutes).toBe(6000);
  });
});
