import request from 'supertest';
import { E2eHarness, seed, startE2e } from './utils';

describe('Dashboard surface (e2e)', () => {
  let h: E2eHarness;
  let httpServer: any;

  beforeEach(async () => {
    h = await startE2e();
    httpServer = h.app.getHttpServer();
  });

  afterEach(async () => {
    await h.close();
  });

  it('serves the static dashboard at /ui/', async () => {
    const res = await request(h.url).get('/ui/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('ReadyOn');
    expect(res.text).toContain('app.js');
  });

  it('serves dashboard JS and CSS', async () => {
    const css = await request(h.url).get('/ui/styles.css');
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toMatch(/css/);
    const js = await request(h.url).get('/ui/app.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
  });

  it('redirects / to /ui/', async () => {
    const res = await request(h.url).get('/').redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/ui/');
  });

  it('GET /employees returns the seeded employees', async () => {
    seed(h, { employeeId: 'emp-1' });
    seed(h, { employeeId: 'emp-2', hcmEmployeeId: 'wd-emp-2' });
    const res = await request(httpServer).get('/employees');
    expect(res.status).toBe(200);
    const ids = res.body.items.map((e: any) => e.id).sort();
    expect(ids).toEqual(['emp-1', 'emp-2']);
  });

  it('GET /employees/:id/ledger returns audit entries newest first', async () => {
    const s = seed(h, { vacationMinutes: 4800 });
    await request(httpServer)
      .post('/time-off-requests')
      .send({
        employeeId: s.employeeId,
        locationId: s.locationId,
        leaveType: 'VACATION',
        startDate: '2026-09-01',
        endDate: '2026-09-01',
        durationMinutes: 480,
      })
      .expect(201);

    const res = await request(httpServer).get(
      `/employees/${s.employeeId}/ledger?limit=10`,
    );
    expect(res.status).toBe(200);
    const items = res.body.items;
    expect(items.length).toBeGreaterThan(0);
    // newest first
    const times = items.map((i: any) => i.created_at);
    const sorted = [...times].sort().reverse();
    expect(times).toEqual(sorted);
    expect(items[0].cause).toBe('REQUEST_CREATED');
  });

  it('GET /admin/outbox shows stats and recent rows', async () => {
    const s = seed(h);
    const c = await request(httpServer)
      .post('/time-off-requests')
      .send({
        employeeId: s.employeeId,
        locationId: s.locationId,
        leaveType: 'VACATION',
        startDate: '2026-09-01',
        endDate: '2026-09-01',
        durationMinutes: 480,
      })
      .expect(201);
    await request(httpServer)
      .post(`/time-off-requests/${c.body.id}/approve`)
      .send({ managerId: 'mgr-1' })
      .expect(200);

    const before = await request(httpServer).get('/admin/outbox');
    expect(before.status).toBe(200);
    expect(before.body.stats.pending).toBe(1);
    expect(before.body.recent[0].type).toBe('HCM_FILE_TIMEOFF');

    await request(httpServer).post('/admin/outbox/flush').expect(200);

    const after = await request(httpServer).get('/admin/outbox');
    expect(after.body.stats.pending).toBe(0);
    expect(after.body.stats.done).toBe(1);
    expect(after.body.recent[0].status).toBe('DONE');
  });

  it('GET /time-off-requests returns all requests (newest first)', async () => {
    const s = seed(h, { vacationMinutes: 4800 });
    for (let i = 1; i <= 3; i++) {
      await request(httpServer)
        .post('/time-off-requests')
        .send({
          employeeId: s.employeeId,
          locationId: s.locationId,
          leaveType: 'VACATION',
          startDate: `2026-09-0${i}`,
          endDate: `2026-09-0${i}`,
          durationMinutes: 480,
        })
        .expect(201);
    }
    const res = await request(httpServer).get('/time-off-requests');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(3);
    const dates = res.body.items.map((r: any) => r.startDate);
    expect(dates).toEqual(['2026-09-03', '2026-09-02', '2026-09-01']);
  });
});
