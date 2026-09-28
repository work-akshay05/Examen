import { normalizeGstin, normalizeInvoiceNumber, normalizeVendorName, parseInvoiceDate, withinMoneyTolerance } from '../validation/validation.utils.js';
import { createMockTallyProvider } from './mock-tally.provider.js';

const comparableFields = [
  { field: 'vendor.name', invoice: (data) => data.vendor?.name, tally: (record) => record.vendor?.name, kind: 'name', severity: 'MEDIUM', type: 'TALLY_VENDOR_MISMATCH' },
  { field: 'vendor.gstin', invoice: (data) => data.vendor?.gstin, tally: (record) => record.vendor?.gstin, kind: 'gstin', severity: 'HIGH', type: 'TALLY_GSTIN_MISMATCH' },
  { field: 'invoiceNumber', invoice: (data) => data.invoiceNumber, tally: (record) => record.invoiceNumber, kind: 'invoiceNumber', severity: 'MEDIUM', type: 'TALLY_INVOICE_NUMBER_MISMATCH' },
  { field: 'invoiceDate', invoice: (data) => data.invoiceDate, tally: (record) => record.invoiceDate, kind: 'date', severity: 'MEDIUM', type: 'TALLY_DATE_MISMATCH' },
  ...['taxableAmount', 'totalAmount', 'cgst', 'sgst', 'igst', 'totalTax'].map((field) => ({ field, invoice: (data) => data[field], tally: (record) => record[field], kind: 'amount', severity: 'HIGH', type: field === 'totalAmount' || field === 'taxableAmount' ? 'TALLY_AMOUNT_MISMATCH' : 'TALLY_TAX_MISMATCH' }))
];

function equal(kind, a, b) {
  if (kind === 'amount') return withinMoneyTolerance(a, b);
  if (kind === 'gstin') return normalizeGstin(a) === normalizeGstin(b);
  if (kind === 'invoiceNumber') return normalizeInvoiceNumber(a) === normalizeInvoiceNumber(b);
  if (kind === 'name') return normalizeVendorName(a) === normalizeVendorName(b);
  if (kind === 'date') {
    const left = parseInvoiceDate(a); const right = parseInvoiceDate(b);
    return Boolean(left && right && left.year === right.year && left.month === right.month && left.day === right.day);
  }
  return a === b;
}

export function createTallyVerificationService({ provider = createMockTallyProvider() } = {}) {
  return {
    async verify(invoiceData = {}) {
      let lookup;
      try { lookup = await provider.lookup(invoiceData); }
      catch { return { status: 'UNAVAILABLE', source: provider.source ?? 'none', matchedRecordId: null, differences: [], verifiedAt: new Date() }; }
      if (!lookup || !['MATCH', 'NOT_FOUND', 'UNAVAILABLE', 'NOT_CHECKED'].includes(lookup.status)) {
        return { status: 'UNAVAILABLE', source: provider.source ?? 'none', matchedRecordId: null, differences: [], verifiedAt: new Date() };
      }
      const base = { status: lookup.status, source: lookup.source ?? provider.source ?? 'none', matchedRecordId: null, differences: [], verifiedAt: new Date() };
      if (lookup.status !== 'MATCH' || !lookup.record) return base;
      const record = lookup.record;
      const differences = [];
      for (const item of comparableFields) {
        const invoiceValue = item.invoice(invoiceData);
        const tallyValue = item.tally(record);
        if (invoiceValue === null || invoiceValue === undefined || invoiceValue === '' || tallyValue === null || tallyValue === undefined || tallyValue === '') continue;
        if (!equal(item.kind, invoiceValue, tallyValue)) {
          differences.push({ type: item.type, field: item.field, invoiceValue, tallyValue, severity: item.severity, message: `${item.field} differs between the invoice and Tally record.` });
        }
      }
      const matchedRecord = Object.fromEntries(['invoiceNumber', 'invoiceDate', 'taxableAmount', 'totalAmount', 'cgst', 'sgst', 'igst', 'totalTax'].filter((field) => record[field] !== undefined).map((field) => [field, record[field]]));
      if (record.vendor) matchedRecord.vendor = Object.fromEntries(['name', 'gstin'].filter((field) => record.vendor[field] !== undefined).map((field) => [field, record.vendor[field]]));
      return { ...base, status: differences.length ? 'MISMATCH' : 'MATCH', matchedRecordId: record.id ?? record._id ?? null, matchedRecord, differences };
    }
  };
}
