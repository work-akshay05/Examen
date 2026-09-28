import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { fileTypeFromBuffer } from 'file-type';
import { authenticate, requireRole } from '../auth.js';
import { Invoice } from '../models/Invoice.js';
import { User } from '../models/User.js';
import { extractInvoice } from '../services/extractInvoice.js';
import { OcrUnavailableError } from '../services/OCRService.js';
import { validateInvoiceWithDuplicates } from '../services/validation/validation.service.js';
import { AiAnalysisError, AiUnavailableError } from '../services/ai/openai.service.js';
import { processInvoice } from '../services/processing/invoiceProcessing.service.js';

const allowedTypes = new Set(['application/pdf', 'image/png', 'image/jpeg']);
const reviewStatuses = ['PENDING', 'APPROVED', 'REJECTED', 'NEEDS_INFORMATION'];
const riskLevels = ['LOW', 'MEDIUM', 'HIGH'];
const processingStatuses = ['UPLOADED', 'PROCESSING', 'OCR_COMPLETED', 'EXTRACTION_COMPLETED', 'OCR_FAILED', 'EXTRACTION_FAILED'];
const reviewSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED', 'NEEDS_INFORMATION']),
  comment: z.string().trim().max(2000).optional().default('')
}).strict().superRefine((value, context) => {
  if (['REJECTED', 'NEEDS_INFORMATION'].includes(value.status) && value.comment.length < 10) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['comment'], message: `${value.status} requires a meaningful comment (at least 10 characters)` });
  }
});
const extractionVerificationSchema = z.object({
  status: z.enum(['VERIFIED', 'CORRECTION_REQUIRED']),
  comment: z.string().trim().max(2000).optional().default('')
}).strict().superRefine((value, context) => {
  if (value.status === 'CORRECTION_REQUIRED' && value.comment.length < 10) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['comment'], message: 'Explain what does not match the source document (at least 10 characters)' });
  }
});
const uploader = (maxBytes) => multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxBytes, files: 1, fields: 0 },
  fileFilter: (_req, file, callback) => {
    if (!allowedTypes.has(file.mimetype)) {
      const error = new Error('Unsupported invoice file type');
      error.code = 'UNSUPPORTED_FILE_TYPE';
      return callback(error);
    }
    return callback(null, true);
  }
});

function serialize(invoice) {
  return typeof invoice.toJSON === 'function' ? invoice.toJSON() : invoice;
}

export function invoiceRoutes({ config, storage, ocr, aiAnalyzer, gstService, tallyService, InvoiceModel = Invoice, UserModel = User }) {
  const router = Router();
  router.use(authenticate(config, UserModel));

  router.post('/', requireRole('marketing', 'admin'), uploader((config.MAX_UPLOAD_MB ?? 1) * 1024 * 1024).single('invoice'), async (req, res, next) => {
    let saved;
    try {
      if (!req.file) return res.status(400).json({ error: 'Choose a PDF, PNG, or JPEG invoice file' });
      const detected = await fileTypeFromBuffer(req.file.buffer);
      if (!detected || !allowedTypes.has(detected.mime) || detected.mime !== req.file.mimetype) {
        return res.status(415).json({ error: 'File contents do not match a supported PDF or image type' });
      }
      saved = await storage.save(req.file);
    } catch (error) {
      return next(error);
    }

    let invoice;
    try {
      invoice = await InvoiceModel.create({
        uploadedBy: req.auth.userId,
        file: saved.metadata,
        processingStatus: 'PROCESSING',
        ocrStatus: 'PENDING',
        extractionStatus: 'PENDING'
      });
    } catch (error) {
      await storage.remove(saved.metadata).catch(() => {});
      return next(error);
    }

    let ocrResult;
    try {
      const result = await ocr.extract(saved.content, saved.metadata.mimeType);
      if (!result || typeof result.text !== 'string' || typeof result.provider !== 'string' || !Array.isArray(result.blocks ?? [])) {
        throw new Error('OCR provider returned malformed output');
      }
      ocrResult = result;
      invoice.rawOcr = { text: result.text, blocks: result.blocks ?? [], provider: result.provider, isMock: result.isMock === true };
      invoice.ocrStatus = 'COMPLETED';
    } catch (error) {
      invoice.processingStatus = 'OCR_FAILED';
      invoice.ocrStatus = error instanceof OcrUnavailableError ? 'UNAVAILABLE' : 'FAILED';
      invoice.processingError = error instanceof OcrUnavailableError ? 'OCR is not configured. The uploaded document is saved for later processing.' : 'OCR processing failed. The uploaded document is saved for retry.';
    }

    if (ocrResult) {
      try {
        invoice.extractedData = extractInvoice(ocrResult.text);
        invoice.extractionStatus = 'COMPLETED';
        invoice.processingStatus = 'EXTRACTION_COMPLETED';
        invoice.extractionMetadata = {
          provider: 'deterministic-label-parser',
          warnings: [
            ...(ocrResult.isMock ? ['Mock OCR is enabled; no real document text was recognized.'] : []),
            ...(Array.isArray(ocrResult.warnings) ? ocrResult.warnings : [])
          ]
        };
        invoice.processingError = null;
      } catch {
        invoice.extractionStatus = 'FAILED';
        invoice.processingStatus = 'EXTRACTION_FAILED';
        invoice.processingError = 'Invoice fields could not be extracted. The uploaded document and OCR text are saved for review.';
      }
    }

    try {
      await invoice.save();
    } catch (error) {
      return next(error);
    }
    return res.status(201).json({ invoice: serialize(invoice) });
  });

  router.get('/', async (req, res, next) => {
    try {
      const baseFilter = ['admin', 'reviewer'].includes(req.auth.role) ? {} : { uploadedBy: req.auth.userId };
      const page = Math.max(1, Number.parseInt(req.query.page ?? '1', 10) || 1);
      const pageSize = Math.min(100, Math.max(1, Number.parseInt(req.query.pageSize ?? '25', 10) || 25));
      const filter = { ...baseFilter };
      if (req.query.search) {
        const term = String(req.query.search).trim().slice(0, 100);
        if (term) {
          const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          filter.$or = [
            { 'extractedData.invoiceNumber': { $regex: escaped, $options: 'i' } },
            { 'extractedData.vendor.name': { $regex: escaped, $options: 'i' } },
            { 'extractedData.vendor.gstin': { $regex: escaped, $options: 'i' } }
          ];
        }
      }
      if (req.query.riskLevel) {
        if (!riskLevels.includes(req.query.riskLevel)) return res.status(400).json({ error: 'Invalid risk level filter' });
        filter['riskAssessment.riskLevel'] = req.query.riskLevel;
      }
      if (req.query.reviewStatus) {
        if (!reviewStatuses.includes(req.query.reviewStatus)) return res.status(400).json({ error: 'Invalid review status filter' });
        filter.reviewStatus = req.query.reviewStatus;
      }
      if (req.query.processingStatus) {
        if (!processingStatuses.includes(req.query.processingStatus)) return res.status(400).json({ error: 'Invalid processing status filter' });
        filter.processingStatus = req.query.processingStatus;
      }
      if (req.query.manualReviewRequired !== undefined) {
        if (!['true', 'false'].includes(req.query.manualReviewRequired)) return res.status(400).json({ error: 'Invalid manual review filter' });
        filter['riskAssessment.manualReviewRequired'] = req.query.manualReviewRequired === 'true';
      }
      if (req.query.vendor) {
        const escaped = String(req.query.vendor).trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (escaped) filter['extractedData.vendor.name'] = { $regex: escaped, $options: 'i' };
      }
      if (req.query.gstin) {
        const escaped = String(req.query.gstin).trim().slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (escaped) filter['extractedData.vendor.gstin'] = { $regex: escaped, $options: 'i' };
      }
      if (req.query.from || req.query.to) {
        const dateRange = {};
        for (const [key, field] of [['from', '$gte'], ['to', '$lte']]) {
          if (req.query[key]) {
            const rawDate = String(req.query[key]);
            const date = new Date(`${rawDate}T${key === 'to' ? '23:59:59.999' : '00:00:00.000'}Z`);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== rawDate) return res.status(400).json({ error: 'Date filters must use a real YYYY-MM-DD date' });
            dateRange[field] = date;
          }
        }
        if (dateRange.$gte && dateRange.$lte && dateRange.$gte > dateRange.$lte) return res.status(400).json({ error: 'Date range start must be before its end' });
        filter.createdAt = dateRange;
      }
      const summaryPipeline = [
        { $match: baseFilter },
        { $group: { _id: null,
          total: { $sum: 1 },
          pendingReview: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$reviewStatus', 'PENDING'] }, 'PENDING'] }, 1, 0] } },
          highRisk: { $sum: { $cond: [{ $eq: ['$riskAssessment.riskLevel', 'HIGH'] }, 1, 0] } },
          mediumRisk: { $sum: { $cond: [{ $eq: ['$riskAssessment.riskLevel', 'MEDIUM'] }, 1, 0] } },
          lowRisk: { $sum: { $cond: [{ $eq: ['$riskAssessment.riskLevel', 'LOW'] }, 1, 0] } },
          approved: { $sum: { $cond: [{ $eq: ['$reviewStatus', 'APPROVED'] }, 1, 0] } },
          rejected: { $sum: { $cond: [{ $eq: ['$reviewStatus', 'REJECTED'] }, 1, 0] } }
        } }
      ];
      const [invoices, total, summaryRows] = await Promise.all([
        InvoiceModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
        InvoiceModel.countDocuments(filter),
        InvoiceModel.aggregate(summaryPipeline)
      ]);
      const { _id, ...summary } = summaryRows[0] ?? { total: 0, pendingReview: 0, highRisk: 0, mediumRisk: 0, lowRisk: 0, approved: 0, rejected: 0 };
      return res.json({ invoices, page, pageSize, total, totalPages: Math.ceil(total / pageSize), summary });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:id/review', requireRole('reviewer', 'admin'), async (req, res, next) => {
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid review action', details: parsed.error.flatten().fieldErrors });
    try {
      if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(404).json({ error: 'Invoice not found' });
      const [invoice, reviewer] = await Promise.all([InvoiceModel.findById(req.params.id), UserModel.findById(req.auth.userId)]);
      if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
      if (!reviewer) return res.status(401).json({ error: 'Reviewer account could not be verified' });
      if (parsed.data.status === 'APPROVED' && invoice.extractionVerification?.status !== 'VERIFIED') {
        return res.status(409).json({ error: 'Compare the extracted values with the source document before approval' });
      }
      const previousStatus = invoice.reviewStatus ?? 'PENDING';
      const timestamp = new Date();
      const { status, comment } = parsed.data;
      const historyItem = { action: status, previousStatus, newStatus: status, reviewer: reviewer._id, reviewerName: reviewer.name, timestamp, comment };
      invoice.reviewStatus = status;
      invoice.reviewComment = comment;
      invoice.reviewedBy = reviewer._id;
      invoice.reviewerName = reviewer.name;
      invoice.reviewedAt = timestamp;
      invoice.reviewHistory.push(historyItem);
      await invoice.save();
      return res.json({ invoiceId: String(invoice._id), reviewStatus: invoice.reviewStatus, reviewedAt: invoice.reviewedAt, reviewer: reviewer.name, comment, reviewHistory: invoice.reviewHistory });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:id/verify-extraction', requireRole('reviewer', 'admin'), async (req, res, next) => {
    const parsed = extractionVerificationSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid source comparison', details: parsed.error.flatten().fieldErrors });
    try {
      if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(404).json({ error: 'Invoice not found' });
      const [invoice, reviewer] = await Promise.all([InvoiceModel.findById(req.params.id), UserModel.findById(req.auth.userId)]);
      if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
      if (!reviewer) return res.status(401).json({ error: 'Reviewer account could not be verified' });
      if (invoice.extractionStatus !== 'COMPLETED' || !invoice.extractedData) return res.status(409).json({ error: 'Invoice extraction must complete before source comparison' });
      const { status, comment } = parsed.data;
      const timestamp = new Date();
      const historyItem = { status, reviewer: reviewer._id, reviewerName: reviewer.name, timestamp, comment };
      invoice.extractionVerification ??= {};
      invoice.extractionVerification.status = status;
      invoice.extractionVerification.reviewer = reviewer._id;
      invoice.extractionVerification.reviewerName = reviewer.name;
      invoice.extractionVerification.verifiedAt = status === 'VERIFIED' ? timestamp : null;
      invoice.extractionVerification.comment = comment;
      invoice.extractionVerification.history.push(historyItem);
      await invoice.save();
      return res.json({ invoiceId: String(invoice._id), extractionVerification: invoice.extractionVerification });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:id/document', async (req, res, next) => {
    try {
      if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(404).json({ error: 'Invoice not found' });
      const invoice = await InvoiceModel.findById(req.params.id);
      if (!invoice || (req.auth.role !== 'admin' && req.auth.role !== 'reviewer' && String(invoice.uploadedBy?._id ?? invoice.uploadedBy) !== req.auth.userId)) {
        return res.status(404).json({ error: 'Invoice not found' });
      }
      const content = await storage.read(invoice.file);
      const filename = encodeURIComponent(invoice.file.originalName ?? 'invoice');
      res.set({ 'content-type': invoice.file.mimeType, 'content-disposition': `inline; filename*=UTF-8''${filename}`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
      return res.send(content);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:id/validate', async (req, res, next) => {
    if (req.auth.role === 'reviewer') return res.status(403).json({ error: 'Only invoice owners and admins can run screening actions' });
    try {
      if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(404).json({ error: 'Invoice not found' });
      const invoice = await InvoiceModel.findById(req.params.id);
      if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
      if (!['admin', 'reviewer'].includes(req.auth.role) && String(invoice.uploadedBy?._id ?? invoice.uploadedBy) !== req.auth.userId) {
        return res.status(404).json({ error: 'Invoice not found' });
      }
      if (invoice.extractionStatus !== 'COMPLETED' || !invoice.extractedData) {
        return res.status(409).json({ error: 'Invoice extraction must complete before validation' });
      }

      const validatedAt = new Date();
      const validation = await validateInvoiceWithDuplicates(invoice.extractedData, {
        now: validatedAt, InvoiceModel, excludeInvoiceId: invoice._id
      });
      validation.validatedAt = validatedAt;
      invoice.validation = validation;
      await invoice.save();
      return res.json({ invoiceId: String(invoice._id), validation });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:id/analyze', async (req, res, next) => {
    if (req.auth.role === 'reviewer') return res.status(403).json({ error: 'Only invoice owners and admins can run screening actions' });
    let invoice;
    let analysisRequested = false;
    try {
      if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(404).json({ error: 'Invoice not found' });
      invoice = await InvoiceModel.findById(req.params.id);
      if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
      if (!['admin', 'reviewer'].includes(req.auth.role) && String(invoice.uploadedBy?._id ?? invoice.uploadedBy) !== req.auth.userId) {
        return res.status(404).json({ error: 'Invoice not found' });
      }
      if (invoice.extractionStatus !== 'COMPLETED' || !invoice.extractedData) {
        return res.status(409).json({ error: 'Invoice extraction must complete before AI analysis' });
      }

      const model = config.OPENAI_MODEL ?? 'gpt-4.1-mini';
      invoice.aiAnalysis = { status: 'PROCESSING', summary: null, anomalies: [], overallAssessment: null, model, analyzedAt: null, error: null };
      await invoice.save();
      analysisRequested = true;
      const result = await aiAnalyzer.analyze(invoice);
      const analyzedAt = new Date();
      invoice.aiAnalysis = { status: 'COMPLETED', ...result, model, analyzedAt, error: null };
      await invoice.save();
      return res.json({ invoiceId: String(invoice._id), aiAnalysis: invoice.aiAnalysis });
    } catch (error) {
      if (invoice) {
        invoice.aiAnalysis = {
          status: 'FAILED', summary: null, anomalies: [], overallAssessment: null,
          model: config.OPENAI_MODEL ?? 'gpt-4.1-mini', analyzedAt: null,
          error: error instanceof AiUnavailableError ? 'OpenAI API key is not configured.' : error instanceof AiAnalysisError ? error.userMessage : 'AI analysis failed. Please try again.'
        };
        try { await invoice.save(); } catch (saveError) { return next(saveError); }
      }
      if (error instanceof AiUnavailableError) return res.status(503).json({ error: 'AI analysis is not configured. Set OPENAI_API_KEY on the backend.' });
      if (error instanceof AiAnalysisError || analysisRequested) return res.status(error instanceof AiAnalysisError && ['QUOTA_EXHAUSTED', 'RATE_LIMITED'].includes(error.failureCode) ? 503 : 502).json({ error: error instanceof AiAnalysisError ? error.userMessage : 'AI analysis failed. Please try again.' });
      return next(error);
    }
  });

  router.post('/:id/process', async (req, res, next) => {
    if (req.auth.role === 'reviewer') return res.status(403).json({ error: 'Only invoice owners and admins can run screening actions' });
    try {
      if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(404).json({ error: 'Invoice not found' });
      const invoice = await InvoiceModel.findById(req.params.id);
      if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
      if (!['admin', 'reviewer'].includes(req.auth.role) && String(invoice.uploadedBy?._id ?? invoice.uploadedBy) !== req.auth.userId) {
        return res.status(404).json({ error: 'Invoice not found' });
      }
      if (invoice.extractionStatus !== 'COMPLETED' || !invoice.extractedData) {
        return res.status(409).json({ error: 'Invoice extraction must complete before screening' });
      }
      const result = await processInvoice(invoice, { InvoiceModel, gstService, tallyService, aiAnalyzer, aiModel: config.OPENAI_MODEL ?? 'gpt-4.1-mini' });
      return res.json({
        invoice: serialize(result.invoice),
        validation: result.validation,
        gstInvestigation: result.gstInvestigation,
        tallyVerification: result.tallyVerification,
        aiAnalysis: result.aiAnalysis,
        riskAssessment: result.riskAssessment
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(404).json({ error: 'Invoice not found' });
      const invoice = await InvoiceModel.findById(req.params.id);
      if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
      if (!['admin', 'reviewer'].includes(req.auth.role) && String(invoice.uploadedBy?._id ?? invoice.uploadedBy) !== req.auth.userId) {
        return res.status(404).json({ error: 'Invoice not found' });
      }
      return res.json({ invoice: serialize(invoice) });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
