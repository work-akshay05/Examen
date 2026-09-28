import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccessToken } from '../src/auth.js';
import { createApp } from '../src/app.js';
import { extractInvoice } from '../src/services/extractInvoice.js';
import { AiAnalysisError } from '../src/services/ai/openai.service.js';

const baseConfig = {
  JWT_SECRET: 'a-test-secret-that-is-at-least-32-characters-long', JWT_EXPIRES_IN: '1h',
  NODE_ENV: 'test', CORS_ORIGIN: 'http://localhost:5173', STORAGE_DIR: './uploads', MAX_UPLOAD_MB: 1, OPENAI_MODEL: 'gpt-4.1-mini'
};
const userA = '64b000000000000000000001';
const userB = '64b000000000000000000002';
const roleByUserId = new Map();
const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kG9sAAAAASUVORK5CYII=', 'base64');

function createHarness(ocr = { async extract() { return { text: '', blocks: [], provider: 'test' }; } }, aiAnalyzer, extraDependencies = {}) {
  const docs = new Map();
  const calls = { stored: 0, extracted: 0, removed: 0 };
  let nextId = 0;
  const storage = {
    async save(file) {
      calls.stored++;
      return { content: file.buffer, metadata: { originalName: file.originalname, storedName: 'test.png', mimeType: file.mimetype, size: file.size, storageProvider: 'local', storagePath: 'test.png' } };
    },
    async remove() { calls.removed++; }
  };
  const InvoiceModel = {
    async create(data) {
      const doc = {
        ...data, _id: (BigInt('0x64b000000000000000000010') + BigInt(++nextId)).toString(16).padStart(24, '0'), save: async () => docs.set(String(doc._id), doc),
        toJSON: () => Object.fromEntries(Object.entries(doc).filter(([key]) => key !== 'save'))
      };
      docs.set(String(doc._id), doc);
      return doc;
    },
    find(filter) {
      let offset = 0; let pageSize = 25;
      return { sort() { return this; }, async lean() {
        const rows = [...docs.values()].filter((doc) => !filter.uploadedBy || doc.uploadedBy === filter.uploadedBy);
        return rows.slice(offset, offset + pageSize);
      }, skip(value) { offset = value; return this; }, limit(value) { pageSize = value; return this; } };
    },
    async countDocuments(filter) { return [...docs.values()].filter((doc) => !filter.uploadedBy || doc.uploadedBy === filter.uploadedBy).length; },
    async aggregate() {
      const rows = [...docs.values()];
      return [{ total: rows.length, pendingReview: rows.filter((doc) => (doc.reviewStatus ?? 'PENDING') === 'PENDING').length,
        highRisk: rows.filter((doc) => doc.riskAssessment?.riskLevel === 'HIGH').length,
        mediumRisk: rows.filter((doc) => doc.riskAssessment?.riskLevel === 'MEDIUM').length,
        lowRisk: rows.filter((doc) => doc.riskAssessment?.riskLevel === 'LOW').length,
        approved: rows.filter((doc) => doc.reviewStatus === 'APPROVED').length,
        rejected: rows.filter((doc) => doc.reviewStatus === 'REJECTED').length }];
    },
    async findById(id) { return docs.get(id) ?? null; },
    findOne(query) {
      const match = [...docs.values()].find((doc) => {
        if (query._id?.$ne && String(doc._id) === String(query._id.$ne)) return false;
        return query.$or.some((candidate) => {
          const vendorPath = Object.keys(candidate).find((key) => key.startsWith('extractedData.vendor.'));
          if ('duplicateLookup.vendorKey' in candidate) {
            return doc.duplicateLookup?.vendorKey === candidate['duplicateLookup.vendorKey'] && doc.duplicateLookup?.invoiceNumber === candidate['duplicateLookup.invoiceNumber'];
          }
          const vendorValue = vendorPath?.endsWith('.gstin') ? doc.extractedData?.vendor?.gstin : doc.extractedData?.vendor?.name;
          return candidate[vendorPath]?.test(vendorValue ?? '') && candidate['extractedData.invoiceNumber']?.test(doc.extractedData?.invoiceNumber ?? '');
        });
      });
      return { select: async () => match ? { _id: match._id } : null };
    }
  };
  const UserModel = extraDependencies.UserModel ?? { async findById(id) { return { _id: id, role: roleByUserId.get(String(id)) ?? 'marketing' }; } };
  const app = createApp(baseConfig, { storage, ocr, InvoiceModel, aiAnalyzer, ...extraDependencies, UserModel });
  const server = app.listen(0);
  const baseUrlPromise = new Promise((resolve) => server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  return { server, baseUrlPromise, docs, calls };
}

function token(userId = userA, role = 'marketing') {
  roleByUserId.set(String(userId), role);
  return createAccessToken({ _id: userId, role }, baseConfig);
}

async function upload(baseUrl, { auth = token(), mime = 'image/png', bytes = pngBytes, filename = 'invoice.png' } = {}) {
  const form = new FormData();
  form.append('invoice', new Blob([bytes], { type: mime }), filename);
  return fetch(`${baseUrl}/api/invoices`, { method: 'POST', headers: auth ? { authorization: `Bearer ${auth}` } : {}, body: form });
}

test('invoice upload rejects an unauthenticated request', async (t) => {
  const harness = createHarness(); t.after(() => new Promise((resolve) => harness.server.close(resolve)));
  assert.equal((await upload(await harness.baseUrlPromise, { auth: '' })).status, 401);
  assert.equal(harness.calls.stored, 0);
});

test('invoice upload rejects unsupported media types and oversized files', async (t) => {
  const harness = createHarness(); t.after(() => new Promise((resolve) => harness.server.close(resolve)));
  const baseUrl = await harness.baseUrlPromise;
  const unsupported = await upload(baseUrl, { mime: 'text/plain', bytes: Buffer.from('not an invoice') });
  assert.equal(unsupported.status, 415);
  const disguisedExecutable = await upload(baseUrl, { mime: 'application/pdf', bytes: Buffer.from('MZ executable payload'), filename: 'invoice.pdf' });
  assert.equal(disguisedExecutable.status, 415);
  const oversized = await upload(baseUrl, { bytes: Buffer.alloc(1024 * 1024 + 1) });
  assert.equal(oversized.status, 413);
  assert.equal(harness.calls.stored, 0);
});

test('PDF and JPEG uploads pass server-side signature validation', async (t) => {
  for (const [mime, filename, bytes] of [
    ['application/pdf', 'invoice.pdf', Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF')],
    ['image/jpeg', 'invoice.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0xff, 0xd9])]
  ]) {
    const harness = createHarness();
    t.after(() => new Promise((resolve) => harness.server.close(resolve)));
    const response = await upload(await harness.baseUrlPromise, { mime, filename, bytes });
    assert.equal(response.status, 201, `${mime} should be accepted`);
    assert.equal((await response.json()).invoice.file.mimeType, mime);
  }
});

test('valid upload stores OCR output and deterministic extraction', async (t) => {
  const recognizedText = [
    'Vendor: Example Services Pvt Ltd', 'Invoice Number: INV-2026-0042', 'Invoice Date: 27/09/2026',
    'GSTIN: 29ABCDE1234F1Z5', 'Taxable Amount: INR 1,000.00', 'CGST: 90.00', 'SGST: 90.00', 'Grand Total: INR 1,180.00'
  ].join('\n');
  const harness = createHarness({ async extract(buffer, mimeType) {
    harness.calls.extracted++;
    assert.ok(buffer.equals(pngBytes)); assert.equal(mimeType, 'image/png');
    return { text: recognizedText, blocks: [{ page: 1, text: 'Invoice' }], provider: 'mock-test', isMock: true };
  } });
  t.after(() => new Promise((resolve) => harness.server.close(resolve)));
  const response = await upload(await harness.baseUrlPromise);
  assert.equal(response.status, 201);
  const { invoice } = await response.json();
  assert.equal(harness.calls.extracted, 1);
  assert.equal(invoice.processingStatus, 'EXTRACTION_COMPLETED');
  assert.equal(invoice.rawOcr.provider, 'mock-test');
  assert.equal(invoice.rawOcr.isMock, true);
  assert.equal(invoice.extractedData.invoiceNumber, 'INV-2026-0042');
  assert.equal(invoice.extractedData.invoiceDate, '2026-09-27');
  assert.equal(invoice.extractedData.vendor.gstin, '29ABCDE1234F1Z5');
  assert.equal(invoice.extractedData.totalTax, 180);
  assert.equal(invoice.extractedData.totalAmount, 1180);
  assert.ok(invoice.extractionMetadata.warnings.length);

  const retrieved = await fetch(`${await harness.baseUrlPromise}/api/invoices/${invoice._id}`, { headers: { authorization: `Bearer ${token()}` } });
  assert.equal(retrieved.status, 200);
});

test('users cannot retrieve another user invoice; admin listing is unrestricted', async (t) => {
  const harness = createHarness(); t.after(() => new Promise((resolve) => harness.server.close(resolve)));
  const baseUrl = await harness.baseUrlPromise;
  const uploadResponse = await upload(baseUrl);
  const { invoice } = await uploadResponse.json();
  const denied = await fetch(`${baseUrl}/api/invoices/${invoice._id}`, { headers: { authorization: `Bearer ${token(userB)}` } });
  assert.equal(denied.status, 404);
  const userList = await fetch(`${baseUrl}/api/invoices`, { headers: { authorization: `Bearer ${token(userB)}` } });
  assert.deepEqual((await userList.json()).invoices, []);
  const adminList = await fetch(`${baseUrl}/api/invoices`, { headers: { authorization: `Bearer ${token(userB, 'admin')}` } });
  assert.equal((await adminList.json()).invoices.length, 1);
});

test('validation endpoint stores findings and detects a prior vendor invoice duplicate', async (t) => {
  const text = [
    'Vendor: Example Services Pvt Ltd', 'Invoice Number: INV-2026-0042', 'Invoice Date: 27/09/2026',
    'GSTIN: 29ABCDE1234F1Z5', 'Taxable Amount: INR 1,000.00', 'CGST: 90.00', 'SGST: 90.00', 'Grand Total: INR 1,180.00'
  ].join('\n');
  const harness = createHarness({ async extract() { return { text, blocks: [], provider: 'test' }; } });
  t.after(() => new Promise((resolve) => harness.server.close(resolve)));
  const baseUrl = await harness.baseUrlPromise;
  await upload(baseUrl);
  const second = await upload(baseUrl);
  const { invoice } = await second.json();
  const denied = await fetch(`${baseUrl}/api/invoices/${invoice._id}/validate`, {
    method: 'POST', headers: { authorization: `Bearer ${token(userB)}` }
  });
  assert.equal(denied.status, 404);
  const response = await fetch(`${baseUrl}/api/invoices/${invoice._id}/validate`, {
    method: 'POST', headers: { authorization: `Bearer ${token()}` }
  });
  assert.equal(response.status, 200);
  const { validation } = await response.json();
  assert.equal(validation.status, 'FAIL');
  assert.ok(validation.findings.some((finding) => finding.ruleId === 'DUPLICATE_INVOICE'));
  assert.ok(validation.validatedAt);

  const saved = await fetch(`${baseUrl}/api/invoices/${invoice._id}`, { headers: { authorization: `Bearer ${token()}` } });
  const savedInvoice = (await saved.json()).invoice;
  assert.equal(savedInvoice.validation.status, 'FAIL');
  assert.ok(savedInvoice.validation.summary.errors > 0);
});

test('validation endpoint refuses invoices without completed extraction', async (t) => {
  const harness = createHarness({ async extract() { throw new Error('unavailable'); } });
  t.after(() => new Promise((resolve) => harness.server.close(resolve)));
  const baseUrl = await harness.baseUrlPromise;
  const uploadResponse = await upload(baseUrl);
  const { invoice } = await uploadResponse.json();
  const response = await fetch(`${baseUrl}/api/invoices/${invoice._id}/validate`, {
    method: 'POST', headers: { authorization: `Bearer ${token()}` }
  });
  assert.equal(response.status, 409);
});

test('analysis endpoint is authenticated, owner-scoped, sends findings, and stores structured output', async (t) => {
  const text = 'Vendor: Example Services Pvt Ltd\nInvoice Number: INV-42\nInvoice Date: 27/09/2026\nGrand Total: INR 1,180.00';
  const expected = { summary: 'A supplied validation mismatch needs review.', anomalies: [{ type: 'AMOUNT_ANOMALY', severity: 'HIGH', description: 'The total differs from the validated amount.', evidence: 'Expected 1180, actual 1200.', reasoning: 'The supplied deterministic finding reports a mismatch.', fields: ['totalAmount'], confidence: 0.91 }], overallAssessment: 'REVIEW_RECOMMENDED' };
  let analyzedInvoice;
  const harness = createHarness({ async extract() { return { text, blocks: [], provider: 'test' }; } }, { async analyze(invoice) { analyzedInvoice = invoice; return expected; } });
  t.after(() => new Promise((resolve) => harness.server.close(resolve)));
  const baseUrl = await harness.baseUrlPromise;
  const uploaded = await (await upload(baseUrl)).json();
  const invoiceId = uploaded.invoice._id;
  const unauthorized = await fetch(`${baseUrl}/api/invoices/${invoiceId}/analyze`, { method: 'POST' });
  assert.equal(unauthorized.status, 401);
  const denied = await fetch(`${baseUrl}/api/invoices/${invoiceId}/analyze`, { method: 'POST', headers: { authorization: `Bearer ${token(userB)}` } });
  assert.equal(denied.status, 404);
  const saved = harness.docs.get(invoiceId);
  saved.validation = { findings: [{ ruleId: 'TOTAL_AMOUNT_MISMATCH', severity: 'HIGH', actual: 1200, expected: 1180 }] };
  const response = await fetch(`${baseUrl}/api/invoices/${invoiceId}/analyze`, { method: 'POST', headers: { authorization: `Bearer ${token()}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(analyzedInvoice.validation.findings, saved.validation.findings);
  assert.equal((await response.json()).aiAnalysis.status, 'COMPLETED');
  assert.deepEqual(saved.aiAnalysis.anomalies, expected.anomalies);
  assert.equal(saved.aiAnalysis.model, 'gpt-4.1-mini');
});

test('analysis endpoint records graceful failure when the backend has no API key', async (t) => {
  const text = 'Vendor: Example Services Pvt Ltd\nInvoice Number: INV-42\nGrand Total: INR 1,180.00';
  const harness = createHarness({ async extract() { return { text, blocks: [], provider: 'test' }; } });
  t.after(() => new Promise((resolve) => harness.server.close(resolve)));
  const baseUrl = await harness.baseUrlPromise;
  const { invoice } = await (await upload(baseUrl)).json();
  const response = await fetch(`${baseUrl}/api/invoices/${invoice._id}/analyze`, { method: 'POST', headers: { authorization: `Bearer ${token()}` } });
  assert.equal(response.status, 503);
  assert.equal(harness.docs.get(invoice._id).aiAnalysis.status, 'FAILED');
  assert.equal(harness.docs.get(invoice._id).aiAnalysis.error, 'OpenAI API key is not configured.');
});

test('analysis endpoint persists a safe FAILED state after provider errors', async (t) => {
  const text = 'Vendor: Example Services Pvt Ltd\nInvoice Number: INV-42\nGrand Total: INR 1,180.00';
  const harness = createHarness({ async extract() { return { text, blocks: [], provider: 'test' }; } }, { async analyze() { throw new AiAnalysisError('provider detail must not leak'); } });
  t.after(() => new Promise((resolve) => harness.server.close(resolve)));
  const baseUrl = await harness.baseUrlPromise;
  const { invoice } = await (await upload(baseUrl)).json();
  const response = await fetch(`${baseUrl}/api/invoices/${invoice._id}/analyze`, { method: 'POST', headers: { authorization: `Bearer ${token()}` } });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'AI analysis failed. Please try again.' });
  assert.equal(harness.docs.get(invoice._id).aiAnalysis.status, 'FAILED');
  assert.equal(harness.docs.get(invoice._id).aiAnalysis.error, 'AI analysis failed. Please try again.');
});

test('full processing endpoint enforces ownership and returns every screening layer despite GPT failure', async (t) => {
  const text = [
    'Vendor: Example Services Pvt Ltd', 'Invoice Number: INV-2026-0042', 'Invoice Date: 27/09/2026',
    'GSTIN: 29ABCDE1234F1Z5', 'Taxable Amount: INR 1,000.00', 'CGST: 90.00', 'SGST: 90.00', 'Grand Total: INR 1,180.00'
  ].join('\n');
  const harness = createHarness({ async extract() { return { text, blocks: [], provider: 'test' }; } }, { async analyze() { throw new Error('model unavailable'); } });
  t.after(() => new Promise((resolve) => harness.server.close(resolve)));
  const baseUrl = await harness.baseUrlPromise;
  const { invoice } = await (await upload(baseUrl)).json();
  const unauthenticated = await fetch(`${baseUrl}/api/invoices/${invoice._id}/process`, { method: 'POST' });
  assert.equal(unauthenticated.status, 401);
  const forbidden = await fetch(`${baseUrl}/api/invoices/${invoice._id}/process`, { method: 'POST', headers: { authorization: `Bearer ${token(userB)}` } });
  assert.equal(forbidden.status, 404);
  const response = await fetch(`${baseUrl}/api/invoices/${invoice._id}/process`, { method: 'POST', headers: { authorization: `Bearer ${token()}` } });
  assert.equal(response.status, 200);
  const body = await response.json();
  for (const key of ['invoice', 'validation', 'gstInvestigation', 'tallyVerification', 'aiAnalysis', 'riskAssessment']) assert.ok(body[key], `${key} returned`);
  assert.equal(body.aiAnalysis.status, 'FAILED');
  assert.equal(body.tallyVerification.source, 'tally_mock');
  assert.equal(body.invoice.riskAssessment.riskScore, body.riskAssessment.riskScore);
  assert.equal(body.invoice.gstInvestigation.externalVerificationStatus, 'UNAVAILABLE');
});

test('extraction leaves unsupported fields null instead of making up invoice data', () => {
  const result = extractInvoice('A receipt that contains no labeled invoice fields.');
  for (const field of ['invoiceNumber', 'invoiceDate', 'subtotal', 'taxableAmount', 'cgst', 'sgst', 'igst', 'totalTax', 'totalAmount']) assert.equal(result[field], null);
  assert.equal(result.vendor.name, null);
  assert.deepEqual(result.lineItems, []);
  assert.equal(result.rawText, 'A receipt that contains no labeled invoice fields.');
});

test('an invoice date is not mistaken for an invoice number and invalid dates remain null', () => {
  const result = extractInvoice('Invoice Date: 31/02/2026\nBuyer GSTIN: 27ABCDE1234F1Z5');
  assert.equal(result.invoiceNumber, null);
  assert.equal(result.invoiceDate, null);
  assert.equal(result.vendor.gstin, null);
  assert.equal(result.buyer.gstin, '27ABCDE1234F1Z5');
});
