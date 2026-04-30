import request from 'supertest';
import { E2eHarness, startE2e } from './utils';

describe('Admin seed endpoint (e2e)', () => {
  let h: E2eHarness;
  let server: any;

  beforeEach(async () => {
    h = await startE2e();
    server = h.app.getHttpServer();
  });
  afterEach(async () => {
    await h.close();
  });

  it('seeds employees, locations, and HCM balances in one shot', async () => {
    const res = await request(server)
      .post('/admin/seed')
      .send({
        employees: [
          {
            employeeId: 'emp-x',
            hcmEmployeeId: 'wd-x',
            name: 'Test',
            balances: [
              {
                locationId: 'loc-X',
                hcmLocationId: 'wd-loc-X',
                leaveType: 'VACATION',
                balanceMinutes: 4800,
              },
              {
                locationId: 'loc-X',
                hcmLocationId: 'wd-loc-X',
                leaveType: 'SICK',
                balanceMinutes: 2400,
              },
            ],
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.seededEmployees).toBe(1);
    expect(res.body.reconcile.scanned).toBeGreaterThanOrEqual(2);

    const balances = await request(server)
      .get('/employees/emp-x/balances')
      .expect(200);
    const types = balances.body.items.map((b: any) => b.leaveType).sort();
    expect(types).toEqual(['SICK', 'VACATION']);
  });

  it('seeded data immediately allows a request flow end-to-end', async () => {
    await request(server)
      .post('/admin/seed')
      .send({
        employees: [
          {
            employeeId: 'emp-x',
            hcmEmployeeId: 'wd-x',
            name: 'Test',
            balances: [
              {
                locationId: 'loc-X',
                hcmLocationId: 'wd-loc-X',
                leaveType: 'VACATION',
                balanceMinutes: 4800,
              },
            ],
          },
        ],
      })
      .expect(200);
    const created = await request(server)
      .post('/time-off-requests')
      .send({
        employeeId: 'emp-x',
        locationId: 'loc-X',
        leaveType: 'VACATION',
        startDate: '2026-06-10',
        endDate: '2026-06-10',
        durationMinutes: 480,
      })
      .expect(201);
    await request(server)
      .post(`/time-off-requests/${created.body.id}/approve`)
      .send({ managerId: 'mgr' })
      .expect(200);
    await request(server).post('/admin/outbox/flush').expect(200);
    const after = await request(server)
      .get('/employees/emp-x/balances/loc-X/VACATION')
      .expect(200);
    expect(after.body.hcmBalanceMinutes).toBe(4320);
  });
});
