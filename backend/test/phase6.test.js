import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccessToken } from '../src/auth.js';
import { createApp } from '../src/app.js';

const config = { JWT_SECRET: 'phase-six-test-secret-with-at-least-32-characters', JWT_EXPIRES_IN: '1h', NODE_ENV: 'test', CORS_ORIGIN: 'http://localhost:5173', STORAGE_DIR: './uploads', MAX_UPLOAD_MB: 1, OPENAI_MODEL: 'gpt-test' };
const adminId = '64b000000000000000000001';
const marketingId = '64b000000000000000000002';
const reviewerId = '64b000000000000000000003';
const invoiceId = '64b000000000000000000010';

function getPath(object, path) { return path.split('.').reduce((value, part) => value?.[part], object); }
function matches(doc, query = {}) {
  for (const [key, expected] of Object.entries(query)) {
    if (key === '$or') { if (!expected.some((part) => matches(doc, part))) return false; continue; }
    const actual = getPath(doc, key);
    if (expected instanceof RegExp) { if (!expected.test(actual ?? '')) return false; }
    else if (expected && typeof expected === 'object' && '$regex' in expected) { if (!new RegExp(expected.$regex, expected.$options).test(actual ?? '')) return false; }
    else if (expected && typeof expected === 'object' && ('$gte' in expected || '$lte' in expected)) {
      const value = new Date(actual).getTime(); if (expected.$gte && value < expected.$gte.getTime()) return false; if (expected.$lte && value > expected.$lte.getTime()) return false;
    } else if (actual !== expected) return false;
  }
  return true;
}

function harness() {
  const invoice = {
    _id: invoiceId, uploadedBy: marketingId, createdAt: new Date('2026-09-01T12:00:00Z'),
    file: { originalName: 'invoice.pdf', mimeType: 'application/pdf', storedName: 'internal-secret-path.pdf' },
    extractedData: { invoiceNumber: 'INV-HIGH-1', invoiceDate: '2026-09-01', vendor: { name: 'Acme Services', gstin: '29ABCDE1234F1Z5' }, totalAmount: 118000 },
    processingStatus: 'EXTRACTION_COMPLETED', extractionStatus: 'COMPLETED', extractionVerification: { status: 'PENDING', history: [] }, reviewStatus: 'PENDING', reviewComment: '', reviewerName: null, reviewedBy: null, reviewedAt: null, reviewHistory: [],
    riskAssessment: { riskScore: 88, riskLevel: 'HIGH', manualReviewRequired: true, signals: [{ points: 25, source: 'tally', message: 'Difference' }], assessedAt: new Date() },
    async save() { return this; }
  };
  const users = new Map([[adminId, { _id: adminId, name: 'Admin Reviewer', role: 'admin' }], [marketingId, { _id: marketingId, name: 'Marketing User', role: 'marketing' }], [reviewerId, { _id: reviewerId, name: 'Human Reviewer', role: 'reviewer' }]]);
  const InvoiceModel = {
    async findById(id) { return String(id) === invoiceId ? invoice : null; },
    find(query) {
      let rows = [invoice].filter((item) => matches(item, query)); let offset = 0; let limit = 25;
      const cursor = { sort() { return this; }, skip(value) { offset = value; return this; }, limit(value) { limit = value; return this; }, async lean() { return rows.slice(offset, offset + limit); } };
      return cursor;
    },
    async countDocuments(query) { return [invoice].filter((item) => matches(item, query)).length; },
    async aggregate() {
      return [{ total: 1, pendingReview: invoice.reviewStatus === 'PENDING' ? 1 : 0, highRisk: 1, mediumRisk: 0, lowRisk: 0, approved: invoice.reviewStatus === 'APPROVED' ? 1 : 0, rejected: invoice.reviewStatus === 'REJECTED' ? 1 : 0 }];
    }
  };
  const UserModel = { async findById(id) { return users.get(String(id)) ?? null; } };
  const app = createApp(config, { InvoiceModel, UserModel, storage: { async read() { return Buffer.from('%PDF-1.4 test'); }, async save() {}, async remove() {} } });
  const server = app.listen(0);
  const baseUrl = new Promise((resolve) => server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  function auth(id = reviewerId, role = 'reviewer') { return `Bearer ${createAccessToken({ _id: id, role }, config)}`; }
  return { invoice, server, baseUrl, auth };
}

async function postReview(h, body, authorization = h.auth()) {
  return fetch(`${await h.baseUrl}/api/invoices/${invoiceId}/review`, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function verifySource(h, status = 'VERIFIED', comment = '') {
  return fetch(`${await h.baseUrl}/api/invoices/${invoiceId}/verify-extraction`, { method: 'POST', headers: { authorization: h.auth(), 'content-type': 'application/json' }, body: JSON.stringify({ status, comment }) });
}

test('reviewer can approve, including a high-risk invoice, with identity and immutable history from the server', async (t) => {
  const h = harness(); t.after(() => new Promise((resolve) => h.server.close(resolve)));
  const response = await postReview(h, { status: 'APPROVED', comment: 'Supporting documents checked.', reviewer: 'forged frontend identity' });
  assert.equal(response.status, 400, 'unexpected client identity fields are rejected');
  assert.equal((await postReview(h, { status: 'APPROVED', comment: 'Supporting documents checked.' })).status, 409, 'approval needs explicit source comparison');
  const verification = await verifySource(h);
  assert.equal(verification.status, 200);
  assert.equal(h.invoice.extractionVerification.reviewerName, 'Human Reviewer');
  assert.equal(h.invoice.extractionVerification.history.length, 1);
  const accepted = await postReview(h, { status: 'APPROVED', comment: 'Supporting documents checked.' });
  assert.equal(accepted.status, 200);
  assert.equal(h.invoice.reviewStatus, 'APPROVED');
  assert.equal(h.invoice.reviewerName, 'Human Reviewer');
  assert.equal(h.invoice.reviewHistory[0].reviewer, reviewerId);
  assert.equal(h.invoice.reviewHistory[0].previousStatus, 'PENDING');
  assert.equal(h.invoice.reviewHistory[0].newStatus, 'APPROVED');
  assert.equal(h.invoice.riskAssessment.riskLevel, 'HIGH');
  assert.equal(h.invoice.riskAssessment.riskScore, 88);
});

test('reviewer can reject with a meaningful reason and the prior status is audited', async (t) => {
  const h = harness(); t.after(() => new Promise((resolve) => h.server.close(resolve)));
  h.invoice.reviewStatus = 'NEEDS_INFORMATION';
  const response = await postReview(h, { status: 'REJECTED', comment: 'Invoice amount is inconsistent.' });
  assert.equal(response.status, 200);
  assert.equal(h.invoice.reviewHistory[0].previousStatus, 'NEEDS_INFORMATION');
  assert.equal(h.invoice.reviewHistory[0].action, 'REJECTED');
  assert.equal(h.invoice.reviewHistory[0].comment, 'Invoice amount is inconsistent.');
});

test('reviewer can request information and status remains separate from risk level', async (t) => {
  const h = harness(); t.after(() => new Promise((resolve) => h.server.close(resolve)));
  const response = await postReview(h, { status: 'NEEDS_INFORMATION', comment: 'Please provide vendor confirmation.' });
  assert.equal(response.status, 200);
  assert.equal(h.invoice.reviewStatus, 'NEEDS_INFORMATION');
  assert.equal(h.invoice.riskAssessment.riskLevel, 'HIGH');
});

test('source comparison rejects unauthenticated, unauthorized, incomplete, or malformed confirmation', async (t) => {
  const h = harness(); t.after(() => new Promise((resolve) => h.server.close(resolve)));
  assert.equal((await verifySource(h, 'VERIFIED', '')).status, 200);
  h.invoice.extractionVerification = { status: 'PENDING', history: [] };
  const missingAuth = await fetch(`${await h.baseUrl}/api/invoices/${invoiceId}/verify-extraction`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'VERIFIED' }) });
  assert.equal(missingAuth.status, 401);
  const unauthorized = await verifySourceWithAuth(h, 'marketing');
  assert.equal(unauthorized.status, 403);
  assert.equal((await verifySource(h, 'MAYBE')).status, 400);
  assert.equal((await verifySource(h, 'CORRECTION_REQUIRED', 'Wrong')).status, 400);
});

async function verifySourceWithAuth(h, role) {
  return fetch(`${await h.baseUrl}/api/invoices/${invoiceId}/verify-extraction`, { method: 'POST', headers: { authorization: h.auth(marketingId, role), 'content-type': 'application/json' }, body: JSON.stringify({ status: 'VERIFIED' }) });
}

test('reviewer can record an extraction mismatch with a reason; that does not approve the invoice', async (t) => {
  const h = harness(); t.after(() => new Promise((resolve) => h.server.close(resolve)));
  const response = await verifySource(h, 'CORRECTION_REQUIRED', 'Invoice total on the scan differs from the extracted value.');
  assert.equal(response.status, 200);
  assert.equal(h.invoice.extractionVerification.status, 'CORRECTION_REQUIRED');
  assert.equal(h.invoice.reviewStatus, 'PENDING');
  assert.equal(h.invoice.extractionVerification.history[0].comment, 'Invoice total on the scan differs from the extracted value.');
  assert.equal((await postReview(h, { status: 'APPROVED' })).status, 409);
});

test('invalid actions, missing authentication, and unauthorized roles are rejected', async (t) => {
  const h = harness(); t.after(() => new Promise((resolve) => h.server.close(resolve)));
  assert.equal((await postReview(h, { status: 'PENDING' })).status, 400);
  assert.equal((await postReview(h, { status: 'APPROVED' }, '')).status, 401);
  assert.equal((await postReview(h, { status: 'APPROVED' }, h.auth(marketingId, 'marketing'))).status, 403);
  const processing = await fetch(`${await h.baseUrl}/api/invoices/${invoiceId}/process`, { method: 'POST', headers: { authorization: h.auth() } });
  assert.equal(processing.status, 403, 'reviewer role can review but cannot run processing actions');
});

test('reject and needs-information require a meaningful reason', async (t) => {
  const h = harness(); t.after(() => new Promise((resolve) => h.server.close(resolve)));
  assert.equal((await postReview(h, { status: 'REJECTED', comment: 'No.' })).status, 400);
  assert.equal((await postReview(h, { status: 'NEEDS_INFORMATION' })).status, 400);
  assert.equal(h.invoice.reviewHistory.length, 0);
});

test('admin review records the authenticated administrator and appends rather than replaces history', async (t) => {
  const h = harness(); t.after(() => new Promise((resolve) => h.server.close(resolve)));
  await postReview(h, { status: 'NEEDS_INFORMATION', comment: 'Need a supplier confirmation.' });
  const first = h.invoice.reviewHistory[0];
  assert.equal((await verifySource(h)).status, 200);
  const secondResponse = await postReview(h, { status: 'APPROVED', comment: 'Supplier confirmation received.' }, h.auth(adminId, 'admin'));
  assert.equal(secondResponse.status, 200);
  assert.equal(h.invoice.reviewHistory.length, 2);
  assert.equal(h.invoice.reviewHistory[0], first);
  assert.equal(h.invoice.reviewHistory[1].reviewer, adminId);
  assert.equal(h.invoice.reviewHistory[1].previousStatus, 'NEEDS_INFORMATION');
});

test('dashboard returns real summary values and supports search, filters, and paging', async (t) => {
  const h = harness(); t.after(() => new Promise((resolve) => h.server.close(resolve)));
  const response = await fetch(`${await h.baseUrl}/api/invoices?page=1&pageSize=1&search=Acme&riskLevel=HIGH&reviewStatus=PENDING`, { headers: { authorization: h.auth() } });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.total, 1);
  assert.equal(result.invoices.length, 1);
  assert.equal(result.summary.highRisk, 1);
  assert.equal(result.summary.pendingReview, 1);
  assert.equal((await fetch(`${await h.baseUrl}/api/invoices?riskLevel=CRITICAL`, { headers: { authorization: h.auth() } })).status, 400);
});

test('source document is served only through the authenticated owner/reviewer route', async (t) => {
  const h = harness(); t.after(() => new Promise((resolve) => h.server.close(resolve)));
  const url = `${await h.baseUrl}/api/invoices/${invoiceId}/document`;
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, { headers: { authorization: h.auth() } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/pdf/);
  assert.match(response.headers.get('content-disposition'), /invoice\.pdf/);
  assert.equal(await response.text(), '%PDF-1.4 test');
});

test('reviewer dashboard scope includes other users invoices and invalid calendar date filters fail', async (t) => {
  const h = harness(); t.after(() => new Promise((resolve) => h.server.close(resolve)));
  const url = `${await h.baseUrl}/api/invoices?from=2026-02-30`;
  assert.equal((await fetch(url, { headers: { authorization: h.auth() } })).status, 400);
  const dashboard = await fetch(`${await h.baseUrl}/api/invoices`, { headers: { authorization: h.auth() } });
  assert.equal(dashboard.status, 200);
  assert.equal((await dashboard.json()).total, 1);
});
