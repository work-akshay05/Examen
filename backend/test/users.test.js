import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccessToken } from '../src/auth.js';
import { createApp } from '../src/app.js';

const config = {
  JWT_SECRET: 'a-test-secret-that-is-at-least-32-characters-long',
  JWT_EXPIRES_IN: '1h',
  NODE_ENV: 'test',
  CORS_ORIGIN: 'http://localhost:5173'
};
const adminId = '64b000000000000000000001';
const reviewerId = '64b000000000000000000002';
const marketingId = '64b000000000000000000003';

function createUserModel() {
  const users = new Map([
    [adminId, { _id: adminId, name: 'Admin', email: 'admin@example.com', role: 'admin' }],
    [reviewerId, { _id: reviewerId, name: 'Reviewer', email: 'reviewer@example.com', role: 'reviewer' }],
    [marketingId, { _id: marketingId, name: 'Marketing', email: 'marketing@example.com', role: 'marketing' }]
  ]);
  return {
    find() {
      return {
        sort() { return this; },
        async lean() { return [...users.values()]; }
      };
    },
    async findById(id) {
      const user = users.get(String(id));
      return user ? { ...user, async save() { users.set(String(this._id), this); } } : null;
    }
  };
}

function authorization(userId, role) {
  return { authorization: `Bearer ${createAccessToken({ _id: userId, role }, config)}` };
}

async function createHarness(t) {
  const app = createApp(config, { UserModel: createUserModel() });
  const server = app.listen(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('user management is restricted to authenticated admins', async (t) => {
  const baseUrl = await createHarness(t);
  assert.equal((await fetch(`${baseUrl}/api/users`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/users`, { headers: authorization(marketingId, 'marketing') })).status, 403);
  const response = await fetch(`${baseUrl}/api/users`, { headers: authorization(adminId, 'admin') });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).users.map(({ role }) => role).sort(), ['admin', 'marketing', 'reviewer']);
});

test('role updates validate allowed targets and prevent self or admin changes', async (t) => {
  const baseUrl = await createHarness(t);
  const headers = { ...authorization(adminId, 'admin'), 'content-type': 'application/json' };
  const invalidRole = await fetch(`${baseUrl}/api/users/${marketingId}/role`, { method: 'PATCH', headers, body: JSON.stringify({ role: 'admin' }) });
  assert.equal(invalidRole.status, 400);
  const selfChange = await fetch(`${baseUrl}/api/users/${adminId}/role`, { method: 'PATCH', headers, body: JSON.stringify({ role: 'marketing' }) });
  assert.equal(selfChange.status, 400);
  const adminChange = await fetch(`${baseUrl}/api/users/${reviewerId}/role`, { method: 'PATCH', headers, body: JSON.stringify({ role: 'marketing' }) });
  assert.equal(adminChange.status, 200);
  assert.equal((await adminChange.json()).user.role, 'marketing');

  const staleReviewerSession = await fetch(`${baseUrl}/api/auth/me`, { headers: authorization(reviewerId, 'reviewer') });
  assert.equal(staleReviewerSession.status, 401);
  assert.equal((await staleReviewerSession.json()).code, 'ROLE_CHANGED');
  const refreshedMarketingSession = await fetch(`${baseUrl}/api/auth/me`, { headers: authorization(reviewerId, 'marketing') });
  assert.equal(refreshedMarketingSession.status, 200);
  assert.equal((await refreshedMarketingSession.json()).role, 'marketing');
});
