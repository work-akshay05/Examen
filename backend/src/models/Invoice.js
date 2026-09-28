import mongoose from 'mongoose';
import { normalizeGstin, normalizeInvoiceNumber, normalizeVendorName } from '../services/validation/validation.utils.js';

const fileSchema = new mongoose.Schema({
  originalName: { type: String, required: true },
  storedName: { type: String, required: true },
  mimeType: { type: String, enum: ['application/pdf', 'image/png', 'image/jpeg'], required: true },
  size: { type: Number, required: true },
  storageProvider: { type: String, enum: ['local'], required: true },
  storagePath: { type: String, required: true }
}, { _id: false });

const invoiceDataSchema = new mongoose.Schema({
  invoiceNumber: { type: String, default: null },
  invoiceDate: { type: String, default: null },
  vendor: { name: { type: String, default: null }, gstin: { type: String, default: null }, address: { type: String, default: null } },
  buyer: { name: { type: String, default: null }, gstin: { type: String, default: null }, address: { type: String, default: null } },
  currency: { type: String, default: null },
  subtotal: { type: Number, default: null },
  taxableAmount: { type: Number, default: null },
  cgst: { type: Number, default: null },
  sgst: { type: Number, default: null },
  igst: { type: Number, default: null },
  totalTax: { type: Number, default: null },
  totalAmount: { type: Number, default: null },
  lineItems: { type: [mongoose.Schema.Types.Mixed], default: [] },
  rawText: { type: String, default: '' }
}, { _id: false });

const reviewHistorySchema = new mongoose.Schema({
  action: { type: String, enum: ['APPROVED', 'REJECTED', 'NEEDS_INFORMATION'], required: true },
  previousStatus: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED', 'NEEDS_INFORMATION'], required: true },
  newStatus: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED', 'NEEDS_INFORMATION'], required: true },
  reviewer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reviewerName: { type: String, required: true },
  timestamp: { type: Date, required: true },
  comment: { type: String, default: '' }
}, { _id: true });

const extractionVerificationHistorySchema = new mongoose.Schema({
  status: { type: String, enum: ['VERIFIED', 'CORRECTION_REQUIRED'], required: true },
  reviewer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reviewerName: { type: String, required: true },
  timestamp: { type: Date, required: true },
  comment: { type: String, default: '' }
}, { _id: true });

const invoiceSchema = new mongoose.Schema({
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  file: { type: fileSchema, required: true },
  extractionVerification: {
    status: { type: String, enum: ['PENDING', 'VERIFIED', 'CORRECTION_REQUIRED'], default: 'PENDING' },
    reviewer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewerName: { type: String, default: null },
    verifiedAt: { type: Date, default: null },
    comment: { type: String, default: '' },
    history: { type: [extractionVerificationHistorySchema], default: [] }
  },
  reviewStatus: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED', 'NEEDS_INFORMATION'], default: 'PENDING', index: true },
  reviewComment: { type: String, default: '' },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewerName: { type: String, default: null },
  reviewedAt: { type: Date, default: null },
  reviewHistory: { type: [reviewHistorySchema], default: [] },
  processingStatus: {
    type: String,
    enum: ['UPLOADED', 'PROCESSING', 'OCR_COMPLETED', 'EXTRACTION_COMPLETED', 'OCR_FAILED', 'EXTRACTION_FAILED'],
    default: 'UPLOADED', required: true
  },
  ocrStatus: { type: String, enum: ['PENDING', 'COMPLETED', 'UNAVAILABLE', 'FAILED'], default: 'PENDING' },
  extractionStatus: { type: String, enum: ['PENDING', 'COMPLETED', 'FAILED'], default: 'PENDING' },
  rawOcr: { text: { type: String, default: null }, blocks: { type: [mongoose.Schema.Types.Mixed], default: [] }, provider: { type: String, default: null }, isMock: { type: Boolean, default: false } },
  extractedData: { type: invoiceDataSchema, default: null },
  duplicateLookup: {
    vendorKey: { type: String, default: null },
    invoiceNumber: { type: String, default: null }
  },
  validation: {
    status: { type: String, enum: ['PASS', 'FAIL', 'WARNING'], default: null },
    isValid: { type: Boolean, default: null },
    findings: { type: [mongoose.Schema.Types.Mixed], default: [] },
    summary: {
      errors: { type: Number, default: 0 },
      warnings: { type: Number, default: 0 },
      info: { type: Number, default: 0 }
    },
    validatedAt: { type: Date, default: null }
  },
  aiAnalysis: {
    status: { type: String, enum: ['NOT_RUN', 'PROCESSING', 'COMPLETED', 'FAILED'], default: 'NOT_RUN' },
    summary: { type: String, default: null },
    anomalies: { type: [mongoose.Schema.Types.Mixed], default: [] },
    overallAssessment: { type: String, enum: ['NO_SIGNIFICANT_ANOMALY', 'REVIEW_RECOMMENDED'], default: null },
    model: { type: String, default: null },
    analyzedAt: { type: Date, default: null },
    error: { type: String, default: null }
  },
  gstInvestigation: {
    status: { type: String, enum: ['VERIFIED', 'FORMAT_VALID', 'MISMATCH', 'UNAVAILABLE', 'NOT_CHECKED'], default: 'NOT_CHECKED' },
    provider: { type: String, enum: ['external', 'gstinapi.in', 'mock', 'none'], default: 'none' },
    externalVerificationStatus: { type: String, enum: ['VERIFIED', 'MISMATCH', 'UNAVAILABLE', 'NOT_CHECKED'], default: 'NOT_CHECKED' },
    externalRegistration: { type: mongoose.Schema.Types.Mixed, default: null },
    gstin: { type: String, default: null },
    formatValid: { type: Boolean, default: null },
    impliedTaxRatePercent: { type: Number, default: null },
    findings: { type: [mongoose.Schema.Types.Mixed], default: [] },
    investigatedAt: { type: Date, default: null }
  },
  tallyVerification: {
    status: { type: String, enum: ['MATCH', 'MISMATCH', 'NOT_FOUND', 'UNAVAILABLE', 'NOT_CHECKED'], default: 'NOT_CHECKED' },
    source: { type: String, enum: ['tally_mock', 'tally_real', 'none'], default: 'none' },
    matchedRecordId: { type: mongoose.Schema.Types.Mixed, default: null },
    matchedRecord: { type: mongoose.Schema.Types.Mixed, default: null },
    differences: { type: [mongoose.Schema.Types.Mixed], default: [] },
    verifiedAt: { type: Date, default: null }
  },
  riskAssessment: {
    riskScore: { type: Number, min: 0, max: 100, default: null },
    riskLevel: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH'], default: null },
    manualReviewRequired: { type: Boolean, default: null },
    signals: { type: [mongoose.Schema.Types.Mixed], default: [] },
    summary: { type: String, default: null },
    assessedAt: { type: Date, default: null }
  },
  extractionMetadata: { provider: { type: String, default: null }, warnings: { type: [String], default: [] } },
  processingError: { type: String, default: null }
}, { timestamps: true, versionKey: false });

invoiceSchema.index({ 'duplicateLookup.vendorKey': 1, 'duplicateLookup.invoiceNumber': 1 });
invoiceSchema.index({ 'extractedData.vendor.gstin': 1, 'extractedData.invoiceNumber': 1 });
invoiceSchema.index({ 'extractedData.vendor.name': 1, 'extractedData.invoiceNumber': 1 });

invoiceSchema.pre('save', function updateDuplicateLookup(next) {
  const data = this.extractedData;
  if (data) {
    const gstin = normalizeGstin(data.vendor?.gstin);
    const vendorName = normalizeVendorName(data.vendor?.name);
    const invoiceNumber = normalizeInvoiceNumber(data.invoiceNumber);
    this.duplicateLookup = {
      vendorKey: gstin ? `gstin:${gstin}` : vendorName ? `name:${vendorName}` : null,
      invoiceNumber: invoiceNumber || null
    };
  }
  next();
});

export const Invoice = mongoose.model('Invoice', invoiceSchema);
