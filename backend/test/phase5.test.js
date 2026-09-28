import test from 'node:test';
import assert from 'node:assert/strict';
import { createGstInvestigationService } from '../src/services/gst/gst.service.js';
import { createMockTallyProvider } from '../src/services/tally/mock-tally.provider.js';
import { createTallyVerificationService } from '../src/services/tally/tally.service.js';
import { assessRisk, collectRiskSignals } from '../src/services/risk/risk.service.js';
import { RISK_POLICY } from '../src/services/risk/risk.config.js';
import { processInvoice } from '../src/services/processing/invoiceProcessing.service.js';

const goodInvoice = {
  invoiceNumber: 'INV-42', invoiceDate: '2026-09-27', vendor: { name: 'Acme Pvt Ltd', gstin: '29ABCDE1234F1Z5' },
  taxableAmount: 1000, subtotal: 1000, cgst: 90, sgst: 90, igst: 0, totalTax: 180, totalAmount: 1180, lineItems: []
};

test('GST investigation normalizes GSTIN, distinguishes format from registration, and accepts matching CGST/SGST', async () => {
  let checkedGstin;
  const service = createGstInvestigationService({ provider: { provider: 'external', async verify(value) { checkedGstin = value; return { status: 'UNAVAILABLE', provider: 'external' }; } } });
  const result = await service.investigate({ ...goodInvoice, vendor: { ...goodInvoice.vendor, gstin: ' 29abcde1234f1z5 ' } });
  assert.equal(checkedGstin, '29ABCDE1234F1Z5');
  assert.equal(result.formatValid, true);
  assert.equal(result.status, 'FORMAT_VALID');
  assert.equal(result.externalVerificationStatus, 'UNAVAILABLE');
  assert.ok(result.findings.some((item) => item.type === 'GSTIN_FORMAT_VALID'));
  assert.equal(result.findings.some((item) => item.type === 'GST_TOTAL_MISMATCH'), false);
  assert.equal(result.impliedTaxRatePercent, 18);
});

test('GST investigation flags invalid and missing GSTIN without claiming registration status', async () => {
  const service = createGstInvestigationService();
  const invalid = await service.investigate({ ...goodInvoice, vendor: { ...goodInvoice.vendor, gstin: 'not-a-gstin' } });
  assert.equal(invalid.status, 'MISMATCH');
  assert.equal(invalid.formatValid, false);
  assert.equal(invalid.externalVerificationStatus, 'NOT_CHECKED');
  const missing = await service.investigate({ ...goodInvoice, vendor: { name: 'Acme', gstin: null } });
  assert.ok(missing.findings.some((item) => item.type === 'GSTIN_MISSING'));
});

test('GST investigation detects CGST/SGST and IGST tax-total mismatches and mixed structures', async () => {
  const service = createGstInvestigationService();
  const localMismatch = await service.investigate({ ...goodInvoice, cgst: 50, sgst: 50, totalTax: 99 });
  assert.ok(localMismatch.findings.some((item) => item.type === 'GST_TOTAL_MISMATCH'));
  const igstMatch = await service.investigate({ ...goodInvoice, cgst: 0, sgst: 0, igst: 180, totalTax: 180 });
  assert.equal(igstMatch.findings.some((item) => item.type === 'GST_TOTAL_MISMATCH'), false);
  const igstMismatch = await service.investigate({ ...goodInvoice, cgst: 0, sgst: 0, igst: 170, totalTax: 180 });
  assert.ok(igstMismatch.findings.some((item) => item.type === 'GST_TOTAL_MISMATCH'));
  const mixed = await service.investigate({ ...goodInvoice, igst: 180 });
  assert.ok(mixed.findings.some((item) => item.type === 'GST_STRUCTURE_INCONSISTENCY'));
});

test('GST investigation checks total arithmetic with the shared one-cent tolerance and reports unavailable honestly', async () => {
  const service = createGstInvestigationService();
  const withinTolerance = await service.investigate({ ...goodInvoice, totalAmount: 1180.01 });
  assert.equal(withinTolerance.findings.some((item) => item.type === 'TAXABLE_AMOUNT_MISMATCH'), false);
  const mismatch = await service.investigate({ ...goodInvoice, totalAmount: 1200 });
  assert.ok(mismatch.findings.some((item) => item.type === 'TAXABLE_AMOUNT_MISMATCH'));
  const unavailable = await service.investigate(goodInvoice);
  assert.equal(unavailable.externalVerificationStatus, 'UNAVAILABLE');
  assert.equal(unavailable.provider, 'none');
  assert.ok(unavailable.findings.some((item) => item.type === 'EXTERNAL_VERIFICATION_UNAVAILABLE'));
});

test('mock Tally provider supports lookup and comparison while labeling its source', async () => {
  const provider = createMockTallyProvider([{ id: 'fixture-1', ...goodInvoice }]);
  const service = createTallyVerificationService({ provider });
  const matched = await service.verify(goodInvoice);
  assert.equal(matched.status, 'MATCH');
  assert.equal(matched.source, 'tally_mock');
  assert.equal(matched.matchedRecordId, 'fixture-1');
  assert.equal(matched.matchedRecord.invoiceNumber, goodInvoice.invoiceNumber);
  assert.equal(matched.matchedRecord.vendor.name, goodInvoice.vendor.name);
  assert.equal(matched.matchedRecord.vendor.address, undefined);

  const amountMismatch = await service.verify({ ...goodInvoice, totalAmount: 1250 });
  assert.equal(amountMismatch.status, 'MISMATCH');
  assert.ok(amountMismatch.differences.some((difference) => difference.type === 'TALLY_AMOUNT_MISMATCH'));
  const gstinMismatch = await service.verify({ ...goodInvoice, vendor: { ...goodInvoice.vendor, gstin: '27ABCDE1234F1Z5' } });
  assert.ok(gstinMismatch.differences.some((difference) => difference.type === 'TALLY_GSTIN_MISMATCH'));
  const vendorMismatch = await service.verify({ ...goodInvoice, vendor: { ...goodInvoice.vendor, name: 'Other Vendor' } });
  assert.ok(vendorMismatch.differences.some((difference) => difference.type === 'TALLY_VENDOR_MISMATCH'));
  const invoiceNumberMismatch = await service.verify({ ...goodInvoice, invoiceNumber: 'INV-43' });
  assert.ok(invoiceNumberMismatch.differences.some((difference) => difference.type === 'TALLY_INVOICE_NUMBER_MISMATCH'));
  const dateMismatch = await service.verify({ ...goodInvoice, invoiceDate: '2026-09-28' });
  assert.ok(dateMismatch.differences.some((difference) => difference.type === 'TALLY_DATE_MISMATCH'));
  const taxMismatch = await service.verify({ ...goodInvoice, cgst: 80 });
  assert.ok(taxMismatch.differences.some((difference) => difference.type === 'TALLY_TAX_MISMATCH'));
});

test('Tally provider reports not found, unavailable, and not checked distinctly', async () => {
  const missing = await createTallyVerificationService({ provider: createMockTallyProvider([]) }).verify(goodInvoice);
  assert.equal(missing.status, 'NOT_FOUND');
  const unavailable = await createTallyVerificationService({ provider: { source: 'none', async lookup() { throw new Error('offline'); } } }).verify(goodInvoice);
  assert.equal(unavailable.status, 'UNAVAILABLE');
  const notChecked = await createTallyVerificationService({ provider: createMockTallyProvider([]) }).verify({ vendor: {}, invoiceNumber: null });
  assert.equal(notChecked.status, 'NOT_CHECKED');
});

test('risk thresholds, weights, duplicate and AI signals follow centralized policy', () => {
  const low = assessRisk({ validation: { findings: [{ ruleId: 'FUTURE_INVOICE_DATE', severity: 'LOW', message: 'Low' }] } });
  assert.equal(low.riskScore, 5); assert.equal(low.riskLevel, 'LOW');
  const medium = assessRisk({ validation: { findings: [1, 2, 3].map((id) => ({ ruleId: `MEDIUM_${id}`, severity: 'MEDIUM', message: 'Medium' })) } });
  assert.equal(medium.riskLevel, 'MEDIUM'); assert.equal(medium.manualReviewRequired, true);
  const high = assessRisk({ validation: { findings: [1, 2, 3].map((id) => ({ ruleId: `HIGH_${id}`, severity: 'HIGH', message: 'High' })) } });
  assert.equal(high.riskLevel, 'HIGH');
  const duplicate = assessRisk({ validation: { findings: [{ ruleId: 'DUPLICATE_INVOICE', severity: 'HIGH', message: 'Duplicate' }] } });
  assert.equal(duplicate.riskScore, RISK_POLICY.points.duplicate); assert.equal(duplicate.manualReviewRequired, true);
  const ai = assessRisk({ aiAnalysis: { status: 'COMPLETED', anomalies: [{ type: 'OTHER', severity: 'MEDIUM', description: 'AI signal', evidence: 'evidence', reasoning: 'reason', fields: [], confidence: 0.7 }] } });
  assert.equal(ai.riskScore, RISK_POLICY.points.ai.MEDIUM);
});

test('risk aggregation caps score and consolidates overlapping amount evidence without double counting', () => {
  const capped = assessRisk({ validation: { findings: [1, 2, 3, 4, 5].map((id) => ({ ruleId: `HIGH_${id}`, severity: 'HIGH', message: 'High' })) } });
  assert.equal(capped.riskScore, 100);
  const result = assessRisk({
    validation: { findings: [{ ruleId: 'TOTAL_AMOUNT_MISMATCH', severity: 'HIGH', message: 'Phase 3 amount mismatch', actual: 1200 }] },
    gstInvestigation: { findings: [{ type: 'TAXABLE_AMOUNT_MISMATCH', severity: 'HIGH', message: 'GST amount mismatch', evidence: 'total mismatch' }] },
    aiAnalysis: { status: 'COMPLETED', anomalies: [{ type: 'AMOUNT_ANOMALY', severity: 'HIGH', description: 'AI amount mismatch', evidence: '1200', reasoning: 'differs', fields: ['totalAmount'] }] }
  });
  assert.equal(result.riskScore, RISK_POLICY.points.validation.HIGH);
  assert.equal(result.signals.length, 1);
  assert.match(result.signals[0].source, /deterministic_validation.*gst_investigation.*ai_analysis/);
  assert.equal(result.signals[0].evidence.split('|').length, 3);
});

test('high-severity GST and Tally mismatches require review; unavailable sources add no points', () => {
  const gst = assessRisk({ gstInvestigation: { findings: [{ type: 'GST_TOTAL_MISMATCH', severity: 'HIGH', message: 'Tax mismatch' }] } });
  assert.equal(gst.riskScore, 25); assert.equal(gst.manualReviewRequired, true);
  const tally = assessRisk({ tallyVerification: { status: 'MISMATCH', differences: [{ type: 'TALLY_AMOUNT_MISMATCH', field: 'totalAmount', severity: 'HIGH', message: 'Different', invoiceValue: 1200, tallyValue: 1180 }] } });
  assert.equal(tally.riskScore, 25); assert.equal(tally.manualReviewRequired, true);
  const unavailable = assessRisk({ gstInvestigation: { findings: [{ type: 'EXTERNAL_VERIFICATION_UNAVAILABLE', severity: 'LOW', message: 'Unavailable' }] }, tallyVerification: { status: 'UNAVAILABLE', differences: [] }, aiAnalysis: { status: 'FAILED', anomalies: [] } });
  assert.equal(unavailable.riskScore, 0); assert.equal(unavailable.riskLevel, 'LOW');
});

function mockInvoice() {
  return { _id: '64b000000000000000000001', extractionStatus: 'COMPLETED', extractedData: { ...goodInvoice }, uploadedBy: '64b000000000000000000002', async save() { this.saveCount = (this.saveCount ?? 0) + 1; } };
}

test('processing pipeline persists validation, GST, mock Tally, AI, and risk results', async () => {
  const invoice = mockInvoice();
  const result = await processInvoice(invoice, {
    InvoiceModel: { findOne() { return { select: async () => null }; } },
    gstService: createGstInvestigationService(),
    tallyService: createTallyVerificationService({ provider: createMockTallyProvider([{ id: 'demo-record', ...goodInvoice }]) }),
    aiAnalyzer: { async analyze() { return { summary: 'No extra anomaly.', anomalies: [], overallAssessment: 'NO_SIGNIFICANT_ANOMALY' }; } },
    aiModel: 'mock-model'
  });
  for (const field of ['validation', 'gstInvestigation', 'tallyVerification', 'aiAnalysis', 'riskAssessment']) assert.ok(invoice[field]);
  assert.equal(result.tallyVerification.source, 'tally_mock');
  assert.equal(result.aiAnalysis.status, 'COMPLETED');
  assert.equal(result.aiAnalysis.model, 'mock-model');
  assert.equal(result.riskAssessment.riskLevel, 'LOW');
  assert.ok(invoice.saveCount >= 5);
});

test('GPT failure still calculates risk, and unavailable GST or Tally does not abort processing', async () => {
  const invoice = mockInvoice();
  const result = await processInvoice(invoice, {
    InvoiceModel: { findOne() { return { select: async () => null }; } },
    gstService: { async investigate() { return { status: 'UNAVAILABLE', provider: 'none', externalVerificationStatus: 'UNAVAILABLE', findings: [{ type: 'EXTERNAL_VERIFICATION_UNAVAILABLE', severity: 'LOW', message: 'Unavailable' }] }; } },
    tallyService: { async verify() { return { status: 'UNAVAILABLE', source: 'none', differences: [] }; } },
    aiAnalyzer: { async analyze() { throw new Error('model timeout'); } }
  });
  assert.equal(result.aiAnalysis.status, 'FAILED');
  assert.deepEqual(result.aiAnalysis.anomalies, []);
  assert.equal(result.gstInvestigation.status, 'UNAVAILABLE');
  assert.equal(result.tallyVerification.status, 'UNAVAILABLE');
  assert.ok(result.riskAssessment);
  assert.equal(result.riskAssessment.riskScore, 0);
});

test('pipeline converts thrown GST/Tally adapter errors to unavailable and still aggregates', async () => {
  const result = await processInvoice(mockInvoice(), {
    InvoiceModel: { findOne() { return { select: async () => null }; } },
    gstService: { async investigate() { throw new Error('GST provider down'); } },
    tallyService: { async verify() { throw new Error('Tally offline'); } },
    aiAnalyzer: { async analyze() { throw new Error('No key'); } }
  });
  assert.equal(result.gstInvestigation.status, 'UNAVAILABLE');
  assert.equal(result.tallyVerification.status, 'UNAVAILABLE');
  assert.equal(result.aiAnalysis.status, 'FAILED');
  assert.ok(result.riskAssessment);
});
