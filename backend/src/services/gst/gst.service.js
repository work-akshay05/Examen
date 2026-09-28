import { normalizeGstin } from '../validation/validation.utils.js';
import { validateTax, validateTotalAmount } from '../validation/validation.rules.js';
import { createUnavailableGstProvider } from './unavailable-gst.provider.js';

const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

function addFinding(findings, type, severity, message, evidence, fields) {
  findings.push({ type, severity, message, evidence, fields });
}

export function createGstInvestigationService({ provider = createUnavailableGstProvider() } = {}) {
  return {
    async investigate(invoice = {}) {
      const findings = [];
      const gstin = normalizeGstin(invoice.vendor?.gstin);
      const formatValid = gstin ? GSTIN_PATTERN.test(gstin) : null;
      const taxValues = [invoice.cgst, invoice.sgst, invoice.igst, invoice.totalTax];
      const hasTax = taxValues.some((value) => typeof value === 'number' && Number.isFinite(value) && value > 0);

      if (!gstin && hasTax) {
        addFinding(findings, 'GSTIN_MISSING', 'MEDIUM', 'Vendor GSTIN is missing while tax amounts are present.', `Tax fields: ${taxValues.map((value, index) => `${['cgst', 'sgst', 'igst', 'totalTax'][index]}=${value ?? 'unavailable'}`).join(', ')}`, ['vendor.gstin']);
      } else if (gstin && !formatValid) {
        addFinding(findings, 'GSTIN_FORMAT_INVALID', 'MEDIUM', 'Vendor GSTIN does not match the expected format.', `Normalized GSTIN: ${gstin}`, ['vendor.gstin']);
      } else if (gstin && formatValid) {
        addFinding(findings, 'GSTIN_FORMAT_VALID', 'LOW', 'GSTIN format appears valid; registration status could not be externally verified.', 'Format validation checks only the character pattern.', ['vendor.gstin']);
      }

      const deterministicTaxFindings = [...validateTax(invoice), ...validateTotalAmount(invoice)];
      for (const item of deterministicTaxFindings) {
        if (item.ruleId === 'TAX_TOTAL_MISMATCH') {
          addFinding(findings, 'GST_TOTAL_MISMATCH', item.severity, item.message, `Expected tax ${item.expected}; extracted total tax ${item.actual}.`, ['cgst', 'sgst', 'igst', 'totalTax']);
        } else if (item.ruleId === 'INCONSISTENT_GST_COMPONENTS') {
          addFinding(findings, 'GST_STRUCTURE_INCONSISTENCY', item.severity, item.message, JSON.stringify(item.actual), ['cgst', 'sgst', 'igst']);
        } else if (item.ruleId === 'TOTAL_AMOUNT_MISMATCH') {
          addFinding(findings, 'TAXABLE_AMOUNT_MISMATCH', item.severity, item.message, `Expected total ${item.expected}; extracted total ${item.actual}.`, ['taxableAmount', 'totalTax', 'totalAmount']);
        }
      }

      let externalVerification = { status: gstin && formatValid ? 'UNAVAILABLE' : 'NOT_CHECKED', provider: provider.provider ?? 'none' };
      if (gstin && formatValid) {
        try {
          externalVerification = await provider.verify(gstin);
          if (!externalVerification || !['VERIFIED', 'MISMATCH', 'UNAVAILABLE', 'NOT_CHECKED'].includes(externalVerification.status)) throw new Error('Invalid GST provider response');
        } catch {
        externalVerification = { status: 'UNAVAILABLE', provider: provider.provider ?? 'none' };
        }
      }
      if (externalVerification.status === 'MISMATCH') {
        addFinding(findings, 'EXTERNAL_GST_REGISTRATION_MISMATCH', 'HIGH', 'The configured external provider reported a GSTIN mismatch.', 'External provider result requires human verification.', ['vendor.gstin']);
      }
      if (externalVerification.status === 'UNAVAILABLE') {
        addFinding(findings, 'EXTERNAL_VERIFICATION_UNAVAILABLE', 'LOW', 'GST registration status could not be externally verified.', 'Only GSTIN format and invoice tax arithmetic were checked.', ['vendor.gstin']);
      }

      const taxableAmount = typeof invoice.taxableAmount === 'number' ? invoice.taxableAmount : invoice.subtotal;
      const observedTotalTax = typeof invoice.totalTax === 'number' ? invoice.totalTax :
        typeof invoice.igst === 'number' && invoice.igst > 0 ? invoice.igst :
          typeof invoice.cgst === 'number' && typeof invoice.sgst === 'number' ? invoice.cgst + invoice.sgst : null;
      const impliedTaxRatePercent = typeof taxableAmount === 'number' && taxableAmount > 0 && typeof observedTotalTax === 'number'
        ? Math.round((observedTotalTax / taxableAmount * 100 + Number.EPSILON) * 100) / 100
        : null;
      const hasMismatch = findings.some((item) => ['HIGH', 'MEDIUM'].includes(item.severity));
      const status = hasMismatch ? 'MISMATCH' : externalVerification.status === 'VERIFIED' ? 'VERIFIED' : gstin && formatValid ? 'FORMAT_VALID' : gstin ? 'MISMATCH' : 'NOT_CHECKED';
      return {
        status,
        provider: externalVerification.provider ?? provider.provider ?? 'none',
        externalVerificationStatus: externalVerification.status,
        externalRegistration: externalVerification.registration ?? null,
        gstin: gstin || null,
        formatValid,
        impliedTaxRatePercent,
        findings,
        investigatedAt: new Date()
      };
    }
  };
}

export { GSTIN_PATTERN };
