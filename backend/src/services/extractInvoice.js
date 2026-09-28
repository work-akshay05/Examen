const GSTIN = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/i;

function labeledValue(text, labelPattern, valuePattern) {
  const expression = new RegExp(`(?:^|\\n)\\s*(?:${labelPattern})\\s*(?:number|no\\.?|#)?\\s*[:#-]?\\s*(${valuePattern})`, 'i');
  return text.match(expression)?.[1]?.trim() ?? null;
}

function amount(text, labels) {
  const labelsPattern = labels.sort((a, b) => b.length - a.length).map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const match = text.match(new RegExp(`(?:^|\\n)\\s*(?:${labelsPattern})\\s*[:=-]?\\s*(?:INR|Rs\\.?|₹)?\\s*([\\d,]+(?:\\.\\d{1,2})?)`, 'i'));
  if (!match) return null;
  const value = Number(match[1].replaceAll(',', ''));
  return Number.isFinite(value) ? value : null;
}

function normalizeDate(value) {
  if (!value) return null;
  const asIsoDate = (year, month, day) => {
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  };
  let match = value.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (match) return asIsoDate(match[1], match[2], match[3]);
  match = value.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
  if (match) return asIsoDate(match[3], match[2], match[1]);
  match = value.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})\b/);
  if (match) {
    const month = new Date(`${match[2]} 1, 2000`).getMonth();
    if (!Number.isNaN(month)) return asIsoDate(match[3], month + 1, match[1]);
  }
  return null;
}

export function extractInvoice(rawText) {
  const text = typeof rawText === 'string' ? rawText : '';
  const invoiceNumber = labeledValue(text, 'invoice\\s+(?:number|no\\.?|#)', '[A-Z0-9][A-Z0-9/_.-]{0,39}');
  const dateValue = labeledValue(text, 'invoice\\s+date|date', '\\d{1,4}[-/. ]+[A-Za-z0-9]{1,9}[-/. ,]+\\d{2,4}');
  const gstinEntries = text.split(/\r?\n/).map((line) => ({ line, gstin: line.match(GSTIN)?.[0]?.toUpperCase() })).filter((entry) => entry.gstin);
  const vendorGstin = gstinEntries.find(({ line }) => /vendor|supplier|seller|^\s*gstin\s*:/i.test(line) && !/buyer|bill\s+to/i.test(line))?.gstin ?? null;
  const buyerGstin = gstinEntries.find(({ line }) => /buyer|bill\s+to|billed\s+to/i.test(line))?.gstin ?? null;
  const vendorName = labeledValue(text, 'vendor|supplier|seller', '[^\\n]{1,120}');
  const buyerName = labeledValue(text, 'buyer|bill\\s+to|billed\\s+to', '[^\\n]{1,120}');
  const subtotal = amount(text, ['subtotal', 'sub total', 'taxable value', 'taxable amount']);
  const cgst = amount(text, ['cgst']);
  const sgst = amount(text, ['sgst']);
  const igst = amount(text, ['igst']);
  const explicitTax = amount(text, ['total tax', 'tax total']);
  const availableTaxes = [cgst, sgst, igst].filter((value) => value !== null);
  const totalTax = availableTaxes.length ? availableTaxes.reduce((sum, value) => sum + value, 0) : explicitTax;
  const totalAmount = amount(text, ['grand total', 'invoice total', 'total amount', 'amount payable', 'total']);
  const parsedDate = normalizeDate(dateValue);
  const currency = /\bINR\b|₹|\bRs\.?\s*\d/i.test(text) ? 'INR' : null;
  return {
    invoiceNumber,
    invoiceDate: parsedDate,
    vendor: { name: vendorName, gstin: vendorGstin, address: null },
    buyer: { name: buyerName, gstin: buyerGstin, address: null },
    currency,
    subtotal,
    taxableAmount: amount(text, ['taxable value', 'taxable amount']) ?? subtotal,
    cgst,
    sgst,
    igst,
    totalTax,
    totalAmount,
    lineItems: [],
    rawText: text
  };
}
