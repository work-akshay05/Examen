import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInvoice, validateInvoiceWithDuplicates } from '../src/services/validation/validation.service.js';
import { findDuplicateInvoice } from '../src/services/validation/duplicateDetection.service.js';

const today = new Date('2026-09-29T12:00:00.000Z');
const validInvoice = () => ({
  invoiceNumber: 'INV-001', invoiceDate: '2026-09-20',
  vendor: { name: 'Acme Services', gstin: '29ABCDE1234F1Z5' },
  taxableAmount: 1000, subtotal: 1000, cgst: 90, sgst: 90, igst: null, totalTax: 180, totalAmount: 1180, lineItems: []
});

test('valid invoice passes without high findings', () => {
  const result = validateInvoice(validInvoice(), { now: today });
  assert.equal(result.status, 'PASS');
  assert.equal(result.isValid, true);
  assert.deepEqual(result.summary, { errors: 0, warnings: 0, info: 0 });
});

test('required invoice number and vendor fields produce specific findings', () => {
  const invoice = validInvoice();
  invoice.invoiceNumber = ' ';
  invoice.vendor.name = null;
  const findings = validateInvoice(invoice, { now: today }).findings;
  assert.ok(findings.some((item) => item.ruleId === 'MISSING_INVOICE_NUMBER'));
  assert.ok(findings.some((item) => item.ruleId === 'MISSING_VENDOR_NAME'));
});

test('invalid and future dates are deterministic UTC findings', () => {
  const invalid = validInvoice(); invalid.invoiceDate = '2026-02-30';
  assert.ok(validateInvoice(invalid, { now: today }).findings.some((item) => item.ruleId === 'INVALID_INVOICE_DATE'));
  const future = validInvoice(); future.invoiceDate = '2026-09-30';
  assert.ok(validateInvoice(future, { now: today }).findings.some((item) => item.ruleId === 'FUTURE_INVOICE_DATE'));
});

test('date-time values require an explicit timezone to avoid local-time interpretation', () => {
  const noZone = validInvoice(); noZone.invoiceDate = '2026-09-20T12:00:00';
  assert.ok(validateInvoice(noZone, { now: today }).findings.some((item) => item.ruleId === 'INVALID_INVOICE_DATE'));
  const utc = validInvoice(); utc.invoiceDate = '2026-09-20T12:00:00Z';
  assert.ok(!validateInvoice(utc, { now: today }).findings.some((item) => item.ruleId === 'INVALID_INVOICE_DATE'));
});

test('non-numeric and negative monetary values are findings', () => {
  const invoice = validInvoice(); invoice.subtotal = '1000'; invoice.igst = -1;
  const findings = validateInvoice(invoice, { now: today }).findings;
  assert.ok(findings.some((item) => item.ruleId === 'INVALID_MONETARY_VALUE' && item.field === 'subtotal'));
  assert.ok(findings.some((item) => item.ruleId === 'NEGATIVE_MONETARY_VALUE' && item.field === 'igst'));
});

test('tax component and invoice-total mismatches report expected and actual amounts', () => {
  const taxInvoice = validInvoice(); taxInvoice.totalTax = 200;
  const taxFinding = validateInvoice(taxInvoice, { now: today }).findings.find((item) => item.ruleId === 'TAX_TOTAL_MISMATCH');
  assert.equal(taxFinding.expected, 180); assert.equal(taxFinding.actual, 200);

  const totalInvoice = validInvoice(); totalInvoice.totalAmount = 1200;
  const totalFinding = validateInvoice(totalInvoice, { now: today }).findings.find((item) => item.ruleId === 'TOTAL_AMOUNT_MISMATCH');
  assert.equal(totalFinding.expected, 1180); assert.equal(totalFinding.actual, 1200);
});

test('zero inactive tax components do not look like mixed GST structure', () => {
  const invoice = validInvoice(); invoice.igst = 0;
  const findings = validateInvoice(invoice, { now: today }).findings;
  assert.ok(!findings.some((item) => item.ruleId === 'INCONSISTENT_GST_COMPONENTS'));
  assert.ok(!findings.some((item) => item.ruleId === 'TAX_TOTAL_MISMATCH'));
});

test('simultaneous positive IGST and CGST/SGST are flagged as inconsistent structure', () => {
  const invoice = validInvoice(); invoice.igst = 18;
  const findings = validateInvoice(invoice, { now: today }).findings;
  assert.ok(findings.some((item) => item.ruleId === 'INCONSISTENT_GST_COMPONENTS'));
});

test('tolerance permits a one-cent rounding difference', () => {
  const invoice = validInvoice();
  invoice.taxableAmount = 100.1; invoice.subtotal = 100.1;
  invoice.cgst = 0.1; invoice.sgst = 0.1; invoice.totalTax = 0.2; invoice.totalAmount = 100.31;
  const result = validateInvoice(invoice, { now: today });
  assert.ok(!result.findings.some((item) => ['TAX_TOTAL_MISMATCH', 'TOTAL_AMOUNT_MISMATCH'].includes(item.ruleId)));
});

test('line-item multiplication and subtotal are checked when the data exists', () => {
  const invoice = validInvoice();
  invoice.lineItems = [{ description: 'Service', quantity: 2, unitPrice: 50, amount: 99 }];
  const findings = validateInvoice(invoice, { now: today }).findings;
  assert.ok(findings.some((item) => item.ruleId === 'LINE_ITEM_AMOUNT_MISMATCH'));
  assert.ok(findings.some((item) => item.ruleId === 'LINE_ITEMS_SUBTOTAL_MISMATCH'));
});

test('missing optional tax and line-item fields do not create false calculation failures', () => {
  const invoice = validInvoice();
  invoice.cgst = invoice.sgst = invoice.igst = invoice.totalTax = null;
  invoice.lineItems = [];
  const findings = validateInvoice(invoice, { now: today }).findings;
  assert.ok(!findings.some((item) => ['TAX_TOTAL_MISMATCH', 'TOTAL_AMOUNT_MISMATCH', 'LINE_ITEMS_SUBTOTAL_MISMATCH'].includes(item.ruleId)));
});

test('zero monetary values are accepted, tax components can support total validation, and invalid GSTIN is flagged', () => {
  const invoice = validInvoice();
  invoice.totalTax = null; invoice.cgst = 0; invoice.sgst = 0; invoice.totalAmount = 1000;
  invoice.vendor.gstin = 'not-a-gstin';
  const findings = validateInvoice(invoice, { now: today }).findings;
  assert.ok(!findings.some((item) => item.ruleId === 'NEGATIVE_MONETARY_VALUE'));
  assert.ok(!findings.some((item) => item.ruleId === 'TOTAL_AMOUNT_MISMATCH'));
  assert.ok(findings.some((item) => item.ruleId === 'INVALID_GSTIN_FORMAT'));
});

test('positive GST components without a vendor GSTIN produce a field warning', () => {
  const invoice = validInvoice(); invoice.vendor.gstin = null;
  const findings = validateInvoice(invoice, { now: today }).findings;
  assert.ok(findings.some((item) => item.ruleId === 'MISSING_VENDOR_GSTIN'));
});

test('duplicate detection normalizes case/spacing and does not match a different vendor', async () => {
  const existing = {
    _id: '64b000000000000000000099',
    duplicateLookup: { vendorKey: 'gstin:29ABCDE1234F1Z5', invoiceNumber: 'inv-001' }
  };
  const InvoiceModel = {
    findOne(query) {
      const indexed = query.$or[0];
      const match = indexed['duplicateLookup.vendorKey'] === existing.duplicateLookup.vendorKey &&
        indexed['duplicateLookup.invoiceNumber'] === existing.duplicateLookup.invoiceNumber &&
        indexed._id?.$ne !== existing._id;
      return { select: async () => match ? existing : null };
    }
  };
  const current = validInvoice(); current.invoiceNumber = ' inv-001 ';
  const duplicate = await findDuplicateInvoice(current, { InvoiceModel, excludeInvoiceId: '64b000000000000000000010' });
  assert.equal(String(duplicate._id), existing._id);

  const anotherVendor = { ...current, vendor: { ...current.vendor, gstin: '27ABCDE1234F1Z5', name: 'Other Vendor' } };
  assert.equal(await findDuplicateInvoice(anotherVendor, { InvoiceModel }), null);
});

test('same invoice number with a different vendor does not create a duplicate finding', async () => {
  const result = await validateInvoiceWithDuplicates(validInvoice(), {
    now: today,
    duplicateLookup: async () => null
  });
  assert.ok(!result.findings.some((item) => item.ruleId === 'DUPLICATE_INVOICE'));
});

test('duplicate key falls back to normalized vendor name when GSTIN is unavailable', async () => {
  let query;
  const InvoiceModel = { findOne(value) { query = value; return { select: async () => null }; } };
  await findDuplicateInvoice({ invoiceNumber: '  INV  55 ', vendor: { name: '  ACME    Studio  ', gstin: null } }, { InvoiceModel });
  assert.equal(query.$or[0]['duplicateLookup.vendorKey'], 'name:acme studio');
  assert.equal(query.$or[0]['duplicateLookup.invoiceNumber'], 'inv 55');
});
