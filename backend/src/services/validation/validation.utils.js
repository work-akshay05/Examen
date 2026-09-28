export const MONEY_FIELDS = Object.freeze(['subtotal', 'taxableAmount', 'cgst', 'sgst', 'igst', 'totalTax', 'totalAmount']);
export const ROUNDING_TOLERANCE_CENTS = 1;

export function isPresent(value) {
  return value !== null && value !== undefined && !(typeof value === 'string' && value.trim() === '');
}

export function toMinorUnits(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round((value + Number.EPSILON) * 100);
}

export function withinMoneyTolerance(expected, actual) {
  const expectedCents = toMinorUnits(expected);
  const actualCents = toMinorUnits(actual);
  return expectedCents !== null && actualCents !== null && Math.abs(expectedCents - actualCents) <= ROUNDING_TOLERANCE_CENTS;
}

function dateParts(year, month, day) {
  const y = Number(year); const m = Number(month); const d = Number(day);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return { year: y, month: m, day: d };
}

export function parseInvoiceDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
  }
  if (typeof value !== 'string') return null;
  let match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return dateParts(match[1], match[2], match[3]);
  match = value.trim().match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i);
  if (match) {
    const dateTime = new Date(value);
    if (!Number.isFinite(dateTime.getTime())) return null;
    return { year: dateTime.getUTCFullYear(), month: dateTime.getUTCMonth() + 1, day: dateTime.getUTCDate() };
  }
  match = value.trim().match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/);
  if (match) return dateParts(match[3], match[2], match[1]);
  match = value.trim().match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  if (match) {
    const month = new Date(`${match[2]} 1, 2000`).getMonth();
    if (!Number.isNaN(month)) return dateParts(match[3], month + 1, match[1]);
  }
  return null;
}

export function normalizeVendorName(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

export function normalizeInvoiceNumber(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

export function normalizeGstin(value) {
  return typeof value === 'string' ? value.trim().toUpperCase().replace(/\s+/g, '') : '';
}

export function exactNormalizedRegex(value) {
  const escaped = value.split(' ').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  return new RegExp(`^${escaped}$`, 'i');
}

export function roundedAmount(value) {
  const cents = toMinorUnits(value);
  return cents === null ? null : cents / 100;
}
