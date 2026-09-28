import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccessToken, authenticate, requireRole, hashPassword, verifyPassword } from '../src/auth.js';
import { createApp } from '../src/app.js';

const config = { JWT_SECRET: 'a-test-secret-that-is-at-least-32-characters-long', JWT_EXPIRES_IN: '1h' };

test('password hashes verify without retaining the plaintext', async () => {
  const password = 'correct horse battery staple';
  const hash = await hashPassword(password);
  assert.notEqual(hash, password);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword('wrong password', hash), false);
});

test('authentication accepts a valid bearer token using the current database role and rejects absent credentials', async () => {
  const token = createAccessToken({ _id: 'user-123', role: 'marketing' }, config);
  const req = { get: () => `Bearer ${token}` };
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  let continued = false;
  await authenticate(config, { async findById() { return { role: 'marketing' }; } })(req, res, () => { continued = true; });
  assert.equal(continued, true);
  assert.deepEqual(req.auth, { userId: 'user-123', role: 'marketing' });

  const missing = { get: () => undefined };
  await authenticate(config)(missing, res, () => assert.fail('must reject missing token'));
  assert.equal(res.code, 401);
});

test('authentication rejects a token when its role is stale after an admin role change', async () => {
  const token = createAccessToken({ _id: 'user-123', role: 'reviewer' }, config);
  const req = { get: () => `Bearer ${token}` };
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  let continued = false;
  await authenticate(config, { async findById() { return { role: 'marketing' }; } })(req, res, () => { continued = true; });
  assert.equal(continued, false);
  assert.equal(res.code, 401);
  assert.equal(res.body.code, 'ROLE_CHANGED');
});

test('role middleware allows authorized roles and rejects others', () => {
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  let continued = false;
  requireRole('admin')({ auth: { role: 'admin' } }, res, () => { continued = true; });
  assert.equal(continued, true);
  continued = false;
  requireRole('admin')({ auth: { role: 'marketing' } }, res, () => { continued = true; });
  assert.equal(continued, false);
  assert.equal(res.code, 403);
});

test('API exposes health and validates registration input before database access', async (t) => {
  const server = createApp({ ...config, NODE_ENV: 'test', CORS_ORIGIN: 'http://localhost:5173' }).listen(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const invalidRegister = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '', email: 'bad', password: 'short', role: 'admin' })
  });
  assert.equal(invalidRegister.status, 400);

  const me = await fetch(`${baseUrl}/api/auth/me`);
  assert.equal(me.status, 401);
});
