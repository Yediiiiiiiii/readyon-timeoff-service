import request from 'supertest';
import { E2eHarness, seed, startE2e } from './utils';

describe('Time-Off API (e2e)', () => {
  let h: E2eHarness;
  let httpServer: any;

  beforeEach(async () => {
    h = await startE2e();
    httpServer = h.app.getHttpServer();
  });

  afterEach(async () => {
    await h.close();
  });

  it('GET /healthz returns ok', async () => {
    const res = await request(httpServer).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('lists balances for a seeded employee', async () => {
    const seedRes = seed(h, { vacationMinutes: 4800 });
    const res = await request(httpServer).get(
      `/employees/${seedRes.employeeId}/balances`,
    );
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(2);
    const vac = res.body.items.find((i: any) => i.leaveType === 'VACATION');
    expect(vac.availableMinutes).toBe(4800);
  });

  it('full create/approve/cancel flow via HTTP', async () => {
    const s = seed(h, { vacationMinutes: 4800 });
    const create = await request(httpServer)
      .post('/time-off-requests')
      .set('Idempotency-Key', 'k-1')
      .send({
        employeeId: s.employeeId,
        locationId: s.locationId,
        leaveType: 'VACATION',
        startDate: '2026-06-10',
        endDate: '2026-06-10',
        durationMinutes: 480,
      });
    expect(create.status).toBe(201);
    const id = create.body.id as string;

    // Idempotent replay returns the same body.
    const replay = await request(httpServer)
      .post('/time-off-requests')
      .set('Idempotency-Key', 'k-1')
      .send({
        employeeId: s.employeeId,
        locationId: s.locationId,
        leaveType: 'VACATION',
        startDate: '2026-06-10',
        endDate: '2026-06-10',
        durationMinutes: 480,
      });
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(id);

    const approve = await request(httpServer)
      .post(`/time-off-requests/${id}/approve`)
      .send({ managerId: 'mgr-1' });
    expect(approve.status).toBe(200);
    expect(approve.body.status).toBe('APPROVED');

    await request(httpServer).post('/admin/outbox/flush').send().expect(200);

    const after = await request(httpServer).get(
      `/employees/${s.employeeId}/balances/${s.locationId}/VACATION`,
    );
    expect(after.body.hcmBalanceMinutes).toBe(4320);
    expect(after.body.reservedMinutes).toBe(0);

    const cancel = await request(httpServer)
      .post(`/time-off-requests/${id}/cancel`)
      .send({});
    expect(cancel.status).toBe(200);
  });

  it('rejects insufficient balance with 409', async () => {
    const s = seed(h, { vacationMinutes: 100 });
    const res = await request(httpServer).post('/time-off-requests').send({
      employeeId: s.employeeId,
      locationId: s.locationId,
      leaveType: 'VACATION',
      startDate: '2026-06-10',
      endDate: '2026-06-10',
      durationMinutes: 200,
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INSUFFICIENT_BALANCE');
  });

  it('idempotency replay with different body returns 409', async () => {
    const s = seed(h, { vacationMinutes: 4800 });
    await request(httpServer)
      .post('/time-off-requests')
      .set('Idempotency-Key', 'k-2')
      .send({
        employeeId: s.employeeId,
        locationId: s.locationId,
        leaveType: 'VACATION',
        startDate: '2026-06-10',
        endDate: '2026-06-10',
        durationMinutes: 480,
      })
      .expect(201);
    const r2 = await request(httpServer)
      .post('/time-off-requests')
      .set('Idempotency-Key', 'k-2')
      .send({
        employeeId: s.employeeId,
        locationId: s.locationId,
        leaveType: 'VACATION',
        startDate: '2026-06-10',
        endDate: '2026-06-10',
        durationMinutes: 240,
      });
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe('IDEMPOTENCY_REPLAY');
  });

  it('rejects invalid input via class-validator', async () => {
    const s = seed(h);
    const res = await request(httpServer).post('/time-off-requests').send({
      employeeId: s.employeeId,
      locationId: s.locationId,
      leaveType: 'NOT_A_TYPE',
      startDate: 'not-a-date',
      endDate: '2026-06-10',
      durationMinutes: 0,
    });
    expect(res.status).toBe(400);
  });
});
