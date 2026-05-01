import { buildTestHarness, TestHarness } from '../test-utils';

describe('EmployeesService', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await buildTestHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('upserts then re-upserts with the same name as a no-op', () => {
    const a = h.employees.upsertEmployee({
      hcmEmployeeId: 'wd-1',
      name: 'Alice',
    });
    const b = h.employees.upsertEmployee({
      hcmEmployeeId: 'wd-1',
      name: 'Alice',
    });
    expect(a.id).toBe(b.id);
  });

  it('updates the name when re-upserting with a new value', () => {
    const a = h.employees.upsertEmployee({
      hcmEmployeeId: 'wd-1',
      name: 'Alice',
    });
    const b = h.employees.upsertEmployee({
      hcmEmployeeId: 'wd-1',
      name: 'Alice II',
    });
    expect(a.id).toBe(b.id);
    expect(b.name).toBe('Alice II');
    expect(h.employees.findById(a.id)!.name).toBe('Alice II');
  });

  it('upsertLocation returns existing if present', () => {
    const a = h.employees.upsertLocation({ hcmLocationId: 'loc-x', name: 'X' });
    const b = h.employees.upsertLocation({ hcmLocationId: 'loc-x', name: 'X' });
    expect(a.id).toBe(b.id);
  });

  it('listEmployees returns inserted rows in creation order', () => {
    h.employees.upsertEmployee({ hcmEmployeeId: 'wd-1', name: 'A' });
    h.employees.upsertEmployee({ hcmEmployeeId: 'wd-2', name: 'B' });
    expect(h.employees.listEmployees().map((e) => e.name)).toEqual(['A', 'B']);
  });

  it('require helpers throw NotFound for missing rows', () => {
    expect(() => h.employees.requireEmployee('nope')).toThrow(/Employee/);
    expect(() => h.employees.requireLocation('nope')).toThrow(/Location/);
  });
});
