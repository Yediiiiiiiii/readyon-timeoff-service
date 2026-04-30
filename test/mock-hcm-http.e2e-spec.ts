import request from 'supertest';
import { E2eHarness, startE2e } from './utils';

describe('Mock HCM HTTP surface (e2e)', () => {
  let h: E2eHarness;
  let server: any;

  beforeEach(async () => {
    h = await startE2e();
    server = h.app.getHttpServer();
  });
  afterEach(async () => {
    await h.close();
  });

  it('seeds, lists, and looks up balances via HTTP', async () => {
    await request(server)
      .post('/mock-hcm/admin/seed-balance')
      .send({
        hcmEmployeeId: 'wd-1',
        hcmLocationId: 'loc',
        leaveType: 'VACATION',
        balanceMinutes: 4800,
      })
      .expect(204);

    const all = await request(server).get('/mock-hcm/balances').expect(200);
    expect(all.body.items.length).toBe(1);
    expect(all.body.items[0].balanceMinutes).toBe(4800);

    const lookup = await request(server)
      .post('/mock-hcm/balances/lookup')
      .send({ hcmEmployeeId: 'wd-1', hcmLocationId: 'loc' })
      .expect(200);
    expect(lookup.body[0].leaveType).toBe('VACATION');
  });

  it('files time-off and decrements balance via HTTP', async () => {
    await request(server)
      .post('/mock-hcm/admin/seed-balance')
      .send({
        hcmEmployeeId: 'wd-1',
        hcmLocationId: 'loc',
        leaveType: 'VACATION',
        balanceMinutes: 480,
      })
      .expect(204);

    const filed = await request(server)
      .post('/mock-hcm/timeoff')
      .send({
        requestId: 'req-1',
        hcmEmployeeId: 'wd-1',
        hcmLocationId: 'loc',
        leaveType: 'VACATION',
        startDate: '2026-06-01',
        endDate: '2026-06-01',
        durationMinutes: 240,
      })
      .expect(201);
    expect(filed.body.hcmRequestId).toMatch(/^hcm-req-/);

    const after = await request(server)
      .post('/mock-hcm/balances/lookup')
      .send({ hcmEmployeeId: 'wd-1', hcmLocationId: 'loc' })
      .expect(200);
    expect(after.body[0].balanceMinutes).toBe(240);
  });

  it('cancels a filed time-off via HTTP', async () => {
    await request(server)
      .post('/mock-hcm/admin/seed-balance')
      .send({
        hcmEmployeeId: 'wd-1',
        hcmLocationId: 'loc',
        leaveType: 'VACATION',
        balanceMinutes: 480,
      })
      .expect(204);
    const filed = await request(server)
      .post('/mock-hcm/timeoff')
      .send({
        requestId: 'req-2',
        hcmEmployeeId: 'wd-1',
        hcmLocationId: 'loc',
        leaveType: 'VACATION',
        startDate: '2026-06-01',
        endDate: '2026-06-01',
        durationMinutes: 240,
      })
      .expect(201);
    await request(server)
      .delete(`/mock-hcm/timeoff/${filed.body.hcmRequestId}`)
      .expect(204);
    const after = await request(server)
      .post('/mock-hcm/balances/lookup')
      .send({ hcmEmployeeId: 'wd-1', hcmLocationId: 'loc' })
      .expect(200);
    expect(after.body[0].balanceMinutes).toBe(480);
  });

  it('bumpBalance simulates an anniversary refresh via HTTP', async () => {
    await request(server)
      .post('/mock-hcm/admin/seed-balance')
      .send({
        hcmEmployeeId: 'wd-1',
        hcmLocationId: 'loc',
        leaveType: 'VACATION',
        balanceMinutes: 480,
      })
      .expect(204);
    const bumped = await request(server)
      .post('/mock-hcm/admin/bump-balance')
      .send({
        hcmEmployeeId: 'wd-1',
        hcmLocationId: 'loc',
        leaveType: 'VACATION',
        deltaMinutes: 2400,
      })
      .expect(200);
    expect(bumped.body.balanceMinutes).toBe(2880);
  });

  it('returns 503 when transient failure is configured (file)', async () => {
    await request(server).post('/mock-hcm/admin/seed-balance').send({
      hcmEmployeeId: 'wd-1',
      hcmLocationId: 'loc',
      leaveType: 'VACATION',
      balanceMinutes: 480,
    });
    await request(server)
      .post('/mock-hcm/admin/failures')
      .send({ fileTimeOffTransientUntil: 1 })
      .expect(200);
    const res = await request(server).post('/mock-hcm/timeoff').send({
      requestId: 'req-tx',
      hcmEmployeeId: 'wd-1',
      hcmLocationId: 'loc',
      leaveType: 'VACATION',
      startDate: '2026-06-01',
      endDate: '2026-06-01',
      durationMinutes: 60,
    });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('HCM_TRANSIENT');
  });

  it('returns 400 when permanent failure is configured (file)', async () => {
    await request(server).post('/mock-hcm/admin/seed-balance').send({
      hcmEmployeeId: 'wd-1',
      hcmLocationId: 'loc',
      leaveType: 'VACATION',
      balanceMinutes: 480,
    });
    await request(server)
      .post('/mock-hcm/admin/failures')
      .send({ fileTimeOffPermanent: true })
      .expect(200);
    const res = await request(server).post('/mock-hcm/timeoff').send({
      requestId: 'req-perm',
      hcmEmployeeId: 'wd-1',
      hcmLocationId: 'loc',
      leaveType: 'VACATION',
      startDate: '2026-06-01',
      endDate: '2026-06-01',
      durationMinutes: 60,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('HCM_PERMANENT');
  });

  it('returns 400 when cancelling unknown id', async () => {
    const res = await request(server).delete('/mock-hcm/timeoff/nope');
    expect(res.status).toBe(400);
  });

  it('admin/reset clears all state', async () => {
    await request(server).post('/mock-hcm/admin/seed-balance').send({
      hcmEmployeeId: 'wd-1',
      hcmLocationId: 'loc',
      leaveType: 'VACATION',
      balanceMinutes: 480,
    });
    await request(server).post('/mock-hcm/admin/reset').expect(204);
    const all = await request(server).get('/mock-hcm/balances').expect(200);
    expect(all.body.items.length).toBe(0);
  });
});
