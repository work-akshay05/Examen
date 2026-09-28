import { RISK_POLICY } from './risk.config.js';

function validationIssue(finding) {
  if (finding.ruleId === 'DUPLICATE_INVOICE') return 'DUPLICATE_INVOICE';
  if (['TOTAL_AMOUNT_MISMATCH'].includes(finding.ruleId)) return 'TOTAL_AMOUNT_MISMATCH';
  if (['TAX_TOTAL_MISMATCH'].includes(finding.ruleId)) return 'TOTAL_TAX_MISMATCH';
  if (['INCONSISTENT_GST_COMPONENTS'].includes(finding.ruleId)) return 'GST_STRUCTURE';
  if (['INVALID_GSTIN_FORMAT', 'MISSING_VENDOR_GSTIN'].includes(finding.ruleId)) return 'GSTIN_FORMAT';
  return `VALIDATION_${finding.ruleId ?? 'FINDING'}`;
}

function aiIssue(anomaly) {
  const fields = (anomaly.fields ?? []).map((field) => field.toLowerCase());
  const type = anomaly.type;
  if (type === 'DUPLICATE_INDICATOR') return 'DUPLICATE_INVOICE';
  if (fields.includes('totalamount')) return 'TOTAL_AMOUNT_MISMATCH';
  if (fields.some((field) => ['totaltax', 'cgst', 'sgst', 'igst'].includes(field)) || type === 'TAX_ANOMALY') return 'TOTAL_TAX_MISMATCH';
  if (fields.some((field) => field.includes('gstin'))) return 'GSTIN_FORMAT';
  if (type === 'AMOUNT_ANOMALY') return 'TOTAL_AMOUNT_MISMATCH';
  return `AI_${type ?? 'ANOMALY'}`;
}

function makeSignal({ issueKey, source, type, severity, points, message, evidence }) {
  return { issueKey, source, type, severity: severity ?? 'LOW', points: Math.max(0, Number(points) || 0), message: message ?? 'Screening signal identified.', evidence: evidence ?? '' };
}

export function collectRiskSignals({ validation, gstInvestigation, tallyVerification, aiAnalysis } = {}, policy = RISK_POLICY) {
  const signals = [];
  for (const finding of validation?.findings ?? []) {
    const duplicate = finding.ruleId === 'DUPLICATE_INVOICE';
    signals.push(makeSignal({ issueKey: validationIssue(finding), source: 'deterministic_validation', type: finding.ruleId ?? 'VALIDATION_FINDING', severity: finding.severity, points: duplicate ? policy.points.duplicate : (policy.points.validation[finding.severity] ?? 0), message: finding.message, evidence: [finding.field, finding.expected !== undefined ? `expected=${JSON.stringify(finding.expected)}` : '', finding.actual !== undefined ? `actual=${JSON.stringify(finding.actual)}` : '', finding.matchedInvoiceId ? `matched invoice=${finding.matchedInvoiceId}` : ''].filter(Boolean).join('; ') }));
  }
  for (const finding of gstInvestigation?.findings ?? []) {
    let issueKey = `GST_${finding.type}`; let points = 0;
    if (finding.type === 'GST_TOTAL_MISMATCH') { issueKey = 'TOTAL_TAX_MISMATCH'; points = policy.points.gst.taxMismatch; }
    else if (finding.type === 'TAXABLE_AMOUNT_MISMATCH') { issueKey = 'TOTAL_AMOUNT_MISMATCH'; points = policy.points.gst.taxMismatch; }
    else if (finding.type === 'GST_STRUCTURE_INCONSISTENCY') { issueKey = 'GST_STRUCTURE'; points = policy.points.gst.structureMismatch; }
    else if (finding.type === 'GSTIN_FORMAT_INVALID' || finding.type === 'GSTIN_MISSING') { issueKey = 'GSTIN_FORMAT'; points = policy.points.gst.gstinInvalid; }
    else if (finding.type === 'EXTERNAL_GST_REGISTRATION_MISMATCH') points = policy.points.gst.externalMismatch;
    else if (finding.type === 'EXTERNAL_VERIFICATION_UNAVAILABLE') points = policy.points.gst.externalUnavailable;
    signals.push(makeSignal({ issueKey, source: 'gst_investigation', type: finding.type, severity: finding.severity, points, message: finding.message, evidence: finding.evidence }));
  }
  for (const difference of tallyVerification?.differences ?? []) {
    let points = policy.points.tally.invoiceDateMismatch;
    if (difference.type === 'TALLY_AMOUNT_MISMATCH') points = policy.points.tally.amountMismatch;
    else if (difference.type === 'TALLY_GSTIN_MISMATCH') points = policy.points.tally.gstinMismatch;
    else if (difference.type === 'TALLY_VENDOR_MISMATCH') points = policy.points.tally.vendorMismatch;
    else if (difference.type === 'TALLY_TAX_MISMATCH') points = policy.points.tally.taxMismatch;
    signals.push(makeSignal({ issueKey: `TALLY_${difference.field?.toUpperCase() ?? difference.type}`, source: tallyVerification.source ?? 'tally', type: difference.type, severity: difference.severity, points, message: difference.message, evidence: `Invoice=${JSON.stringify(difference.invoiceValue)}; Tally=${JSON.stringify(difference.tallyValue)}` }));
  }
  if (tallyVerification?.status === 'NOT_FOUND') {
    signals.push(makeSignal({ issueKey: 'TALLY_RECORD_NOT_FOUND', source: tallyVerification.source ?? 'tally', type: 'TALLY_RECORD_NOT_FOUND', severity: 'MEDIUM', points: policy.points.tally.notFound, message: 'No corresponding record was found in the configured Tally source.', evidence: `Source: ${tallyVerification.source ?? 'none'}` }));
  }
  for (const anomaly of aiAnalysis?.status === 'COMPLETED' ? aiAnalysis.anomalies ?? [] : []) {
    const issueKey = aiIssue(anomaly);
    signals.push(makeSignal({ issueKey, source: 'ai_analysis', type: anomaly.type, severity: anomaly.severity, points: policy.points.ai[anomaly.severity] ?? 0, message: anomaly.description, evidence: `${anomaly.evidence} ${anomaly.reasoning}`.trim() }));
  }
  return signals;
}

function consolidateSignals(signals) {
  const grouped = new Map();
  for (const signal of signals) {
    const group = grouped.get(signal.issueKey) ?? { ...signal, sources: new Set(), evidenceItems: [], messages: new Set(), severityRank: 0 };
    group.sources.add(signal.source);
    if (signal.evidence) group.evidenceItems.push(`${signal.source}: ${signal.evidence}`);
    if (signal.message) group.messages.add(signal.message);
    group.points = Math.max(group.points, signal.points);
    const rank = { LOW: 1, MEDIUM: 2, HIGH: 3 }[signal.severity] ?? 0;
    if (rank > group.severityRank) { group.severity = signal.severity; group.severityRank = rank; }
    grouped.set(signal.issueKey, group);
  }
  return [...grouped.values()].map(({ issueKey, source, sources, evidenceItems, messages, severityRank, ...signal }) => ({
    ...signal, issueKey, source: [...sources].join(' + '),
    message: [...messages].join(' / '), evidence: evidenceItems.join(' | ')
  }));
}

export function assessRisk(evidence, { assessedAt = new Date(), policy = RISK_POLICY } = {}) {
  const rawSignals = collectRiskSignals(evidence, policy);
  const signals = consolidateSignals(rawSignals);
  const riskScore = Math.min(policy.thresholds.cap, signals.reduce((sum, signal) => sum + signal.points, 0));
  const riskLevel = riskScore <= policy.thresholds.lowMax ? 'LOW' : riskScore <= policy.thresholds.mediumMax ? 'MEDIUM' : 'HIGH';
  const duplicateExists = signals.some((signal) => signal.issueKey === 'DUPLICATE_INVOICE');
  const tallyMismatch = (evidence.tallyVerification?.differences?.length ?? 0) > 0;
  const highGstFinding = (evidence.gstInvestigation?.findings ?? []).some((finding) => finding.severity === 'HIGH');
  const highSeverity = signals.some((signal) => signal.severity === 'HIGH');
  const manualReviewRequired = (riskLevel === 'HIGH') || (policy.manualReview.mediumRisk && riskLevel === 'MEDIUM') ||
    (policy.manualReview.anyHighSeveritySignal && highSeverity) || (policy.manualReview.duplicateAlways && duplicateExists) ||
    (policy.manualReview.tallyMismatchAlways && tallyMismatch) || (policy.manualReview.highGstFindingAlways && highGstFinding);
  const summary = riskScore === 0
    ? 'No weighted screening signals were identified from the available evidence.'
    : `${riskLevel} screening risk (${riskScore}/100) based on ${signals.length} consolidated signal${signals.length === 1 ? '' : 's'}. Human review ${manualReviewRequired ? 'is required' : 'is not required by the configured rules'}.`;
  return { riskScore, riskLevel, manualReviewRequired, signals, summary, assessedAt };
}

export { RISK_POLICY };
