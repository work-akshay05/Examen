import { parseInvoiceDate } from '../validation/validation.utils.js';

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function decodeXml(value) {
  return value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&').trim();
}

function tagValue(xml, tag) {
  const safeTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = xml.match(new RegExp(`<${safeTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${safeTag}>`, 'i'));
  return match ? decodeXml(match[1].replace(/<[^>]*>/g, '')) : null;
}

function parseAmount(value) {
  if (!value) return null;
  const amount = Number(value.replaceAll(',', '').trim());
  return Number.isFinite(amount) ? Math.abs(amount) : null;
}

function tallyDate(value) {
  const parts = parseInvoiceDate(value);
  if (!parts) return null;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${parts.day}-${months[parts.month - 1]}-${parts.year}`;
}

function buildDayBookRequest(invoice, companyName) {
  const date = tallyDate(invoice.invoiceDate);
  if (!date) return null;
  const company = companyName ? `<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>` : '';
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>Day Book</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVFROMDATE TYPE="Date">${date}</SVFROMDATE><SVTODATE TYPE="Date">${date}</SVTODATE>${company}</STATICVARIABLES></DESC></BODY></ENVELOPE>`;
}

function parseVouchers(xml) {
  const vouchers = [];
  const voucherTags = xml.match(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/gi) ?? [];
  for (const voucher of voucherTags) {
    const ledgerEntries = [...voucher.matchAll(/<(?:ALL)?LEDGERENTRIES\.LIST\b[^>]*>([\s\S]*?)<\/(?:ALL)?LEDGERENTRIES\.LIST>/gi)].map((match) => match[1]);
    const partyEntry = ledgerEntries.find((entry) => /<ISPARTYLEDGER\b[^>]*>Yes<\/ISPARTYLEDGER>/i.test(entry));
    const partyName = tagValue(voucher, 'PARTYLEDGERNAME') ?? (partyEntry && tagValue(partyEntry, 'LEDGERNAME'));
    const partyAmount = partyEntry && parseAmount(tagValue(partyEntry, 'AMOUNT'));
    const taxAmounts = { cgst: 0, sgst: 0, igst: 0 };
    for (const entry of ledgerEntries) {
      const ledger = (tagValue(entry, 'LEDGERNAME') ?? '').toLowerCase();
      const amount = parseAmount(tagValue(entry, 'AMOUNT'));
      if (amount === null) continue;
      if (ledger.includes('cgst')) taxAmounts.cgst += amount;
      else if (ledger.includes('sgst')) taxAmounts.sgst += amount;
      else if (ledger.includes('igst')) taxAmounts.igst += amount;
    }
    const taxValues = Object.values(taxAmounts);
    const hasTax = taxValues.some((amount) => amount > 0);
    const date = tagValue(voucher, 'DATE');
    const parsedDate = date && /^\d{8}$/.test(date) ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : date;
    const totalTax = hasTax ? taxValues.reduce((sum, amount) => sum + amount, 0) : null;
    const totalAmount = partyAmount ?? parseAmount(tagValue(voucher, 'AMOUNT'));
    vouchers.push({
      id: tagValue(voucher, 'GUID') ?? tagValue(voucher, 'MASTERID') ?? null,
      invoiceNumber: tagValue(voucher, 'REFERENCE') ?? tagValue(voucher, 'VOUCHERNUMBER'),
      invoiceDate: parsedDate,
      vendor: { name: partyName, gstin: tagValue(partyEntry ?? voucher, 'PARTYGSTIN') ?? tagValue(partyEntry ?? voucher, 'GSTIN') },
      totalAmount,
      cgst: hasTax ? taxAmounts.cgst : null,
      sgst: hasTax ? taxAmounts.sgst : null,
      igst: hasTax ? taxAmounts.igst : null,
      totalTax
    });
  }
  return vouchers;
}

function isRelevant(voucher, invoice) {
  const invoiceNumber = String(invoice.invoiceNumber ?? '').trim().toLowerCase();
  if (!invoiceNumber) return false;
  const references = [voucher.invoiceNumber].filter(Boolean).map((value) => String(value).trim().toLowerCase());
  return references.includes(invoiceNumber);
}

export function createTallyXmlProvider({ TALLY_XML_URL = 'http://127.0.0.1:9000', TALLY_COMPANY_NAME, TALLY_REQUEST_TIMEOUT_MS = 10000 } = {}) {
  const endpoint = new URL(TALLY_XML_URL);
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('TALLY_XML_URL must use HTTP or HTTPS');

  return {
    source: 'tally_real',
    displayName: 'TallyPrime XML',
    async lookup(invoice = {}) {
      const request = buildDayBookRequest(invoice, TALLY_COMPANY_NAME);
      if (!request) return { status: 'NOT_CHECKED', source: this.source, record: null };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TALLY_REQUEST_TIMEOUT_MS);
      timeout.unref?.();
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'text/xml; charset=utf-8', accept: 'text/xml' },
          body: request,
          signal: controller.signal,
          redirect: 'error'
        });
        if (!response.ok) return { status: 'UNAVAILABLE', source: this.source, record: null };
        const xml = await response.text();
        if (Buffer.byteLength(xml, 'utf8') > MAX_RESPONSE_BYTES || !/<ENVELOPE\b/i.test(xml) || /<STATUS>0<\/STATUS>/i.test(xml)) {
          return { status: 'UNAVAILABLE', source: this.source, record: null };
        }
        const record = parseVouchers(xml).find((voucher) => isRelevant(voucher, invoice));
        return record
          ? { status: 'MATCH', source: this.source, record }
          : { status: 'NOT_FOUND', source: this.source, record: null };
      } catch {
        return { status: 'UNAVAILABLE', source: this.source, record: null };
      } finally {
        clearTimeout(timeout);
      }
    }
  };
}
