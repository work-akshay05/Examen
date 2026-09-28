import { validateInvoiceRules } from './validation.rules.js';
import { findDuplicateInvoice } from './duplicateDetection.service.js';

export function summarizeFindings(findings) {
  const summary = {
    errors: findings.filter((item) => item.severity === 'HIGH').length,
    warnings: findings.filter((item) => ['MEDIUM', 'LOW'].includes(item.severity)).length,
    info: findings.filter((item) => item.severity === 'INFO').length
  };
  const status = summary.errors ? 'FAIL' : summary.warnings ? 'WARNING' : 'PASS';
  return { status, isValid: findings.length === 0, findings, summary };
}

export function validateInvoice(invoice, { now = new Date() } = {}) {
  return summarizeFindings(validateInvoiceRules(invoice, now));
}

export async function validateInvoiceWithDuplicates(invoice, {
  now = new Date(), duplicateLookup = findDuplicateInvoice, InvoiceModel, excludeInvoiceId
} = {}) {
  const result = validateInvoice(invoice, { now });
  const duplicate = await duplicateLookup(invoice, { InvoiceModel, excludeInvoiceId });
  if (duplicate) {
    result.findings.push({
      ruleId: 'DUPLICATE_INVOICE', severity: 'HIGH', category: 'DUPLICATE',
      message: 'A previous invoice with the same vendor and invoice number already exists.',
      field: 'invoiceNumber', matchedInvoiceId: String(duplicate._id)
    });
    return summarizeFindings(result.findings);
  }
  return result;
}
