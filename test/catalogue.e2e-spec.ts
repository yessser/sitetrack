import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp, pool, resetDb, signUp } from './helpers';

describe('catalogue', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(resetDb);
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  // A store manager with one unit and a Binders > Cement tree.
  async function setup() {
    const manager = await signUp(app, 'store_manager');
    const bag = (await manager.post('/units', { name: 'bag', symbol: 'bag' })).body;
    const binders = (await manager.post('/categories', { name: 'Binders' })).body;
    const cement = (await manager.post('/categories', { name: 'Cement', parentId: binders.id })).body;
    return { manager, bag, binders, cement };
  }

  describe('access', () => {
    it('lets everyone read but only store managers and SuperAdmins write', async () => {
      const { bag, cement } = await setup();
      const user = await signUp(app, 'user');
      const admin = await signUp(app, 'super_admin');
      const material = { name: 'Cement, OPC 50 kg bag', categoryId: cement.id, unitId: bag.id };

      expect((await user.get('/units')).status).toBe(200);
      expect((await user.get('/categories')).status).toBe(200);
      expect((await user.get('/materials')).status).toBe(200);

      expect((await user.post('/units', { name: 'kilogram', symbol: 'kg' })).status).toBe(403);
      expect((await user.post('/categories', { name: 'Steel' })).status).toBe(403);
      expect((await user.post('/materials', material)).status).toBe(403);

      const created = await admin.post('/materials', material);
      expect(created.status).toBe(201);
      expect((await user.patch(`/materials/${created.body.id}`, { name: 'x' })).status).toBe(403);
      expect((await user.delete(`/materials/${created.body.id}`)).status).toBe(403);
    });

    it('requires login', async () => {
      const anon = await signUp(app);
      await anon.post('/auth/logout');
      expect((await anon.get('/materials')).status).toBe(401);
    });
  });

  describe('units', () => {
    it('keeps symbols unique regardless of case', async () => {
      const { manager } = await setup();
      expect((await manager.post('/units', { name: 'Bag', symbol: 'BAG' })).status).toBe(409);
    });

    it('edits a unit, and refuses to delete one that materials use', async () => {
      const { manager, bag, cement } = await setup();
      const res = await manager.patch(`/units/${bag.id}`, { name: '50 kg bag' });
      expect(res.body).toEqual({ id: bag.id, name: '50 kg bag', symbol: 'bag' });

      await manager.post('/materials', { name: 'Cement', categoryId: cement.id, unitId: bag.id });
      expect((await manager.delete(`/units/${bag.id}`)).status).toBe(409);

      const kg = (await manager.post('/units', { name: 'kilogram', symbol: 'kg' })).body;
      expect((await manager.delete(`/units/${kg.id}`)).status).toBe(204);
      expect((await manager.delete(`/units/${kg.id}`)).status).toBe(404);
    });
  });

  describe('categories', () => {
    it('returns the tree as a flat list', async () => {
      const { manager, binders, cement } = await setup();
      const { body } = await manager.get('/categories');
      expect(body).toEqual([
        { id: binders.id, name: 'Binders', parentId: null },
        { id: cement.id, name: 'Cement', parentId: binders.id },
      ]);
    });

    it('keeps names unique among siblings only', async () => {
      const { manager, binders } = await setup();
      expect((await manager.post('/categories', { name: 'binders' })).status).toBe(409);
      expect((await manager.post('/categories', { name: 'cement', parentId: binders.id })).status).toBe(409);
      const other = (await manager.post('/categories', { name: 'Steel' })).body;
      expect((await manager.post('/categories', { name: 'Cement', parentId: other.id })).status).toBe(201);
    });

    it('404s an unknown parent', async () => {
      const { manager } = await setup();
      expect((await manager.post('/categories', { name: 'X', parentId: 999 })).status).toBe(404);
    });

    it('moves a category, but never inside itself or its own subtree', async () => {
      const { manager, binders, cement } = await setup();
      const opc = (await manager.post('/categories', { name: 'OPC', parentId: cement.id })).body;

      expect((await manager.patch(`/categories/${binders.id}`, { parentId: binders.id })).status).toBe(409);
      expect((await manager.patch(`/categories/${binders.id}`, { parentId: opc.id })).status).toBe(409);

      const moved = await manager.patch(`/categories/${opc.id}`, { parentId: binders.id, name: 'Portland' });
      expect(moved.body).toEqual({ id: opc.id, name: 'Portland', parentId: binders.id });
      const top = await manager.patch(`/categories/${opc.id}`, { parentId: null });
      expect(top.body.parentId).toBeNull();
    });

    it('refuses to delete a category with subcategories or materials', async () => {
      const { manager, bag, binders, cement } = await setup();
      expect((await manager.delete(`/categories/${binders.id}`)).status).toBe(409);

      const m = await manager.post('/materials', { name: 'Cement', categoryId: cement.id, unitId: bag.id });
      expect((await manager.delete(`/categories/${cement.id}`)).status).toBe(409);
      // Removed materials still count: their rows keep pointing at the category.
      await manager.delete(`/materials/${m.body.id}`);
      expect((await manager.delete(`/categories/${cement.id}`)).status).toBe(409);

      const empty = (await manager.post('/categories', { name: 'Empty' })).body;
      expect((await manager.delete(`/categories/${empty.id}`)).status).toBe(204);
    });
  });

  describe('materials', () => {
    it('creates a material with its category and unit, names need not be unique', async () => {
      const { manager, bag, binders, cement } = await setup();
      const body = { name: 'Cement, OPC 50 kg bag', categoryId: cement.id, unitId: bag.id };
      const res = await manager.post('/materials', body);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        name: 'Cement, OPC 50 kg bag',
        category: { id: cement.id, name: 'Cement', parentId: binders.id },
        unit: { id: bag.id, name: 'bag', symbol: 'bag' },
      });
      expect((await manager.post('/materials', body)).status).toBe(201);
    });

    it('404s an unknown category or unit', async () => {
      const { manager, bag, cement } = await setup();
      const noCat = await manager.post('/materials', { name: 'X', categoryId: 999, unitId: bag.id });
      expect(noCat.status).toBe(404);
      expect(noCat.body.message).toBe('Category not found');
      const noUnit = await manager.post('/materials', { name: 'X', categoryId: cement.id, unitId: 999 });
      expect(noUnit.body.message).toBe('Unit not found');
    });

    it('edits every field, unit included', async () => {
      const { manager, bag, binders, cement } = await setup();
      const kg = (await manager.post('/units', { name: 'kilogram', symbol: 'kg' })).body;
      const { body } = await manager.post('/materials', { name: 'Cement', categoryId: cement.id, unitId: bag.id });

      const res = await manager.patch(`/materials/${body.id}`, { name: 'Lime', categoryId: binders.id, unitId: kg.id });
      expect(res.body).toMatchObject({ name: 'Lime', category: { id: binders.id }, unit: { id: kg.id } });
    });

    it('removes softly: gone from the catalogue, 404 afterwards', async () => {
      const { manager, bag, cement } = await setup();
      const { body } = await manager.post('/materials', { name: 'Cement', categoryId: cement.id, unitId: bag.id });

      expect((await manager.delete(`/materials/${body.id}`)).status).toBe(204);
      expect((await manager.get(`/materials/${body.id}`)).status).toBe(404);
      expect((await manager.patch(`/materials/${body.id}`, { name: 'x' })).status).toBe(404);
      expect((await manager.delete(`/materials/${body.id}`)).status).toBe(404);
      expect((await manager.get('/materials')).body.total).toBe(0);
    });

    it('searches by name, filters by category including subcategories, sorts and pages', async () => {
      const { manager, bag, binders, cement } = await setup();
      const steel = (await manager.post('/categories', { name: 'Steel' })).body;
      const add = (name: string, categoryId: number) =>
        manager.post('/materials', { name, categoryId, unitId: bag.id });
      await add('Cement, OPC 50 kg bag', cement.id);
      await add('Lime, hydrated', binders.id);
      await add('Rebar 12 mm', steel.id);
      await add('Cement, PPC 50 kg bag', cement.id);

      const names = async (qs: string) => (await manager.get(`/materials?${qs}`)).body.items.map((m: any) => m.name);

      expect(await names('')).toEqual(['Cement, OPC 50 kg bag', 'Cement, PPC 50 kg bag', 'Lime, hydrated', 'Rebar 12 mm']);
      expect(await names('q=ppc')).toEqual(['Cement, PPC 50 kg bag']);
      // % and _ are literal, not wildcards.
      expect(await names('q=%25')).toEqual([]);
      expect(await names(`category=${binders.id}`)).toEqual([
        'Cement, OPC 50 kg bag',
        'Cement, PPC 50 kg bag',
        'Lime, hydrated',
      ]);
      expect(await names(`category=${cement.id}&order=desc`)).toEqual([
        'Cement, PPC 50 kg bag',
        'Cement, OPC 50 kg bag',
      ]);

      const page = await manager.get('/materials?limit=2&offset=2');
      expect(page.body).toMatchObject({ total: 4, limit: 2, offset: 2 });
      expect(page.body.items.map((m: any) => m.name)).toEqual(['Lime, hydrated', 'Rebar 12 mm']);

      expect((await manager.get('/materials?sort=createdAt')).status).toBe(400);
    });
  });
});
