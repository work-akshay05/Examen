import { isPresent, MONEY_FIELDS, parseInvoiceDate, roundedAmount, toMinorUnits, withinMoneyTolerance } from './validation.utils.js';

function finding(ruleId, severity, category, message, field, values = {}) {
  return { ruleId, severity, category, message, ...(field ? { field } : {}), ...values };
}

function isValidMoney(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function validateRequiredFields(invoice) {
  const findings = [];
  const required = [
    ['invoiceNumber', 'MISSING_INVOICE_NUMBER', invoice?.invoiceNumber, 'HIGH', 'Invoice number is missing.'],
    ['invoiceDate', 'MISSING_INVOICE_DATE', invoice?.invoiceDate, 'MEDIUM', 'Invoice date is missing.'],
    ['vendor.name', 'MISSING_VENDOR_NAME', invoice?.vendor?.name, 'HIGH', 'Vendor name is missing.'],
    ['totalAmount', 'MISSING_TOTAL_AMOUNT', invoice?.totalAmount, 'HIGH', 'Total amount is missing.']
  ];
  for (const [field, ruleId, value, severity, message] of required) {
    if (!isPresent(value)) findings.push(finding(ruleId, severity, 'REQUIRED_FIELD', message, field));
  }
  return findings;
}

export function validateDate(invoice, now = new Date()) {
  if (!isPresent(invoice?.invoiceDate)) return [];
  const parsed = parseInvoiceDate(invoice.invoiceDate);
  if (!parsed) return [finding('INVALID_INVOICE_DATE', 'HIGH', 'DATE', 'Invoice date is not a valid calendar date.', 'invoiceDate', { actual: invoice.invoiceDate })];
  const today = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() };
  const dateValue = Date.UTC(parsed.year, parsed.month - 1, parsed.day);
  const todayValue = Date.UTC(today.year, today.month - 1, today.day);
  if (dateValue > todayValue) return [finding('FUTURE_INVOICE_DATE', 'MEDIUM', 'DATE', 'Invoice date is later than the current UTC date.', 'invoiceDate', { expected: `${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`, actual: invoice.invoiceDate })];
  return [];
}

export function validateMonetaryValues(invoice) {
  const findings = [];
  for (const field of MONEY_FIELDS) {
    const value = invoice?.[field];
    if (!isPresent(value)) continue;
    if (!isValidMoney(value)) {
      findings.push(finding('INVALID_MONETARY_VALUE', 'HIGH', 'AMOUNT', `${field} must be a finite numeric amount.`, field, { actual: value }));
    } else if (value < 0) {
      findings.push(finding('NEGATIVE_MONETARY_VALUE', 'HIGH', 'AMOUNT', `${field} should not be negative.`, field, { actual: value }));
    }
  }
  return findings;
}

function safeMoney(invoice, field) {
  const value = invoice?.[field];
  return isValidMoney(value) && value >= 0 ? value : null;
}

export function validateTax(invoice) {
  const findings = [];
  const cgst = safeMoney(invoice, 'cgst');
  const sgst = safeMoney(invoice, 'sgst');
  const igst = safeMoney(invoice, 'igst');
  const totalTax = safeMoney(invoice, 'totalTax');
  const hasPositiveComponentTax = (cgst ?? 0) > 0 || (sgst ?? 0) > 0;
  const hasPositiveIgst = (igst ?? 0) > 0;
  const hasMixedStructure = hasPositiveIgst && hasPositiveComponentTax;

  const vendorGstin = invoice?.vendor?.gstin;
  if ([cgst, sgst, igst].some((value) => value !== null && value > 0) && !isPresent(vendorGstin)) {
    findings.push(finding('MISSING_VENDOR_GSTIN', 'MEDIUM', 'REQUIRED_FIELD', 'Vendor GSTIN is missing even though GST components are present.', 'vendor.gstin'));
  } else if (isPresent(vendorGstin) && !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/i.test(String(vendorGstin).replace(/\s+/g, ''))) {
    findings.push(finding('INVALID_GSTIN_FORMAT', 'MEDIUM', 'STRUCTURE', 'Vendor GSTIN is not in the expected format.', 'vendor.gstin', { actual: vendorGstin }));
  }

  if (hasMixedStructure) {
    findings.push(finding('INCONSISTENT_GST_COMPONENTS', 'HIGH', 'TAX', 'IGST and CGST/SGST components are both present; confirm the tax structure.', 'igst', { actual: { cgst, sgst, igst } }));
    return findings;
  }
  let expectedTax = null;
  if (hasPositiveIgst || (igst !== null && cgst === null && sgst === null)) expectedTax = igst;
  else if (cgst !== null && sgst !== null) expectedTax = cgst + sgst;
  else if (igst !== null) expectedTax = igst;
  if (expectedTax !== null && totalTax !== null && !withinMoneyTolerance(expectedTax, totalTax)) {
    findings.push(finding('TAX_TOTAL_MISMATCH', 'HIGH', 'TAX', 'Calculated tax components do not match the recorded total tax.', 'totalTax', { expected: roundedAmount(expectedTax), actual: roundedAmount(totalTax) }));
  }
  return findings;
}

export function validateTotalAmount(invoice) {
  const taxable = safeMoney(invoice, 'taxableAmount') ?? safeMoney(invoice, 'subtotal');
  const recordedTotalTax = safeMoney(invoice, 'totalTax');
  const cgst = safeMoney(invoice, 'cgst');
  const sgst = safeMoney(invoice, 'sgst');
  const igst = safeMoney(invoice, 'igst');
  const hasPositiveLocalTax = (cgst ?? 0) > 0 || (sgst ?? 0) > 0;
  const hasPositiveInterTax = (igst ?? 0) > 0;
  const componentTotalTax = hasPositiveLocalTax && hasPositiveInterTax ? null :
    hasPositiveInterTax || (igst !== null && cgst === null && sgst === null) ? igst :
      cgst !== null && sgst !== null ? cgst + sgst : igst;
  const totalTax = recordedTotalTax ?? componentTotalTax;
  const totalAmount = safeMoney(invoice, 'totalAmount');
  if (taxable === null || totalTax === null || totalAmount === null) return [];
  const expected = (toMinorUnits(taxable) + toMinorUnits(totalTax)) / 100;
  if (withinMoneyTolerance(expected, totalAmount)) return [];
  return [finding('TOTAL_AMOUNT_MISMATCH', 'HIGH', 'AMOUNT', 'Invoice total does not match taxable amount plus recorded tax.', 'totalAmount', { expected, actual: roundedAmount(totalAmount) })];
}

export function validateLineItems(invoice) {
  const items = invoice?.lineItems;
  if (!isPresent(items)) return [];
  if (!Array.isArray(items)) return [finding('INVALID_LINE_ITEMS', 'MEDIUM', 'STRUCTURE', 'Line items must be provided as a list.', 'lineItems')];
  if (items.length === 0) return [];
  const findings = [];
  let sumCents = 0;
  let allAmountsPresent = true;

  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      findings.push(finding('INVALID_LINE_ITEM', 'MEDIUM', 'STRUCTURE', 'Line item must be an object.', `lineItems.${index}`));
      allAmountsPresent = false;
      continue;
    }
    for (const field of ['quantity', 'unitPrice', 'amount']) {
      if (!isPresent(item[field])) continue;
      if (!isValidMoney(item[field])) {
        findings.push(finding('INVALID_LINE_ITEM_VALUE', 'HIGH', 'AMOUNT', `Line item ${field} must be a finite numeric value.`, `lineItems.${index}.${field}`, { actual: item[field] }));
      } else if (item[field] < 0) {
        findings.push(finding('NEGATIVE_LINE_ITEM_VALUE', 'HIGH', 'AMOUNT', `Line item ${field} should not be negative.`, `lineItems.${index}.${field}`, { actual: item[field] }));
      }
    }
    const quantity = isValidMoney(item.quantity) && item.quantity >= 0 ? item.quantity : null;
    const unitPrice = isValidMoney(item.unitPrice) && item.unitPrice >= 0 ? item.unitPrice : null;
    const amount = isValidMoney(item.amount) && item.amount >= 0 ? item.amount : null;
    if (quantity !== null && unitPrice !== null && amount !== null) {
      const expected = Math.round((quantity * unitPrice + Number.EPSILON) * 100) / 100;
      if (!withinMoneyTolerance(expected, amount)) {
        findings.push(finding('LINE_ITEM_AMOUNT_MISMATCH', 'HIGH', 'AMOUNT', 'Line item amount does not match quantity multiplied by unit price.', `lineItems.${index}.amount`, { expected, actual: roundedAmount(amount) }));
      }
    }
    if (amount === null) allAmountsPresent = false;
    else sumCents += toMinorUnits(amount);
  }

  const subtotal = safeMoney(invoice, 'taxableAmount') ?? safeMoney(invoice, 'subtotal');
  if (allAmountsPresent && subtotal !== null) {
    const expected = sumCents / 100;
    if (!withinMoneyTolerance(expected, subtotal)) {
      findings.push(finding('LINE_ITEMS_SUBTOTAL_MISMATCH', 'MEDIUM', 'AMOUNT', 'Line item amounts do not add up to the invoice taxable subtotal.', 'taxableAmount', { expected, actual: roundedAmount(subtotal) }));
    }
  }
  return findings;
}

export function validateInvoiceRules(invoice, now = new Date()) {
  if (!invoice || typeof invoice !== 'object' || Array.isArray(invoice)) {
    return [finding('INVALID_INVOICE_DATA', 'HIGH', 'STRUCTURE', 'Invoice data is not a valid object.')];
  }
  return [
    ...validateRequiredFields(invoice),
    ...validateDate(invoice, now),
    ...validateMonetaryValues(invoice),
    ...validateTax(invoice),
    ...validateTotalAmount(invoice),
    ...validateLineItems(invoice)
  ];
}
