import { normalizeGstin, normalizeInvoiceNumber, normalizeVendorName, parseInvoiceDate } from '../validation/validation.utils.js';

function dateKey(value) {
  const parts = parseInvoiceDate(value);
  return parts ? `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}` : '';
}

export function createMockTallyProvider(records = []) {
  return {
    source: 'tally_mock',
    displayName: 'Mock Tally Data',
    async lookup(invoice = {}) {
      const invoiceNumber = normalizeInvoiceNumber(invoice.invoiceNumber);
      const gstin = normalizeGstin(invoice.vendor?.gstin);
      const vendorName = normalizeVendorName(invoice.vendor?.name);
      const invoiceDate = dateKey(invoice.invoiceDate);
      if (!invoiceNumber && !(gstin && invoiceDate)) return { status: 'NOT_CHECKED', source: 'tally_mock', record: null };

      const record = records.find((candidate) => {
        const sameNumber = invoiceNumber && normalizeInvoiceNumber(candidate.invoiceNumber) === invoiceNumber;
        const sameGstin = gstin && normalizeGstin(candidate.vendor?.gstin) === gstin;
        const sameName = vendorName && normalizeVendorName(candidate.vendor?.name) === vendorName;
        const sameDate = invoiceDate && dateKey(candidate.invoiceDate) === invoiceDate;
        if (invoiceNumber && sameNumber && (sameGstin || sameName || sameDate)) return true;
        if (gstin && invoiceDate && sameGstin && sameDate) return true;
        return Boolean(sameGstin && sameDate);
      });
      return record
        ? { status: 'MATCH', source: 'tally_mock', record }
        : { status: 'NOT_FOUND', source: 'tally_mock', record: null };
    }
  };
}
