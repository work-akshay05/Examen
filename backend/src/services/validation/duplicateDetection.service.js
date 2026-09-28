import { Invoice } from '../../models/Invoice.js';
import { exactNormalizedRegex, normalizeGstin, normalizeInvoiceNumber, normalizeVendorName } from './validation.utils.js';

export function buildDuplicateQuery(invoice, excludeInvoiceId) {
  const invoiceNumber = normalizeInvoiceNumber(invoice?.invoiceNumber);
  const gstin = normalizeGstin(invoice?.vendor?.gstin);
  const vendorName = normalizeVendorName(invoice?.vendor?.name);
  if (!invoiceNumber || (!gstin && !vendorName)) return null;

  const vendorField = gstin ? 'extractedData.vendor.gstin' : 'extractedData.vendor.name';
  const vendorValue = gstin || vendorName;
  const vendorKey = gstin ? `gstin:${gstin}` : `name:${vendorName}`;
  const query = { $or: [
    { 'duplicateLookup.vendorKey': vendorKey, 'duplicateLookup.invoiceNumber': invoiceNumber },
    { [vendorField]: exactNormalizedRegex(vendorValue), 'extractedData.invoiceNumber': exactNormalizedRegex(invoiceNumber) }
  ] };
  if (excludeInvoiceId) query._id = { $ne: excludeInvoiceId };
  return query;
}

export async function findDuplicateInvoice(invoice, { InvoiceModel = Invoice, excludeInvoiceId } = {}) {
  const query = buildDuplicateQuery(invoice, excludeInvoiceId);
  if (!query) return null;
  return InvoiceModel.findOne(query).select('_id');
}
