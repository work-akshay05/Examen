import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { authenticate } from './auth.js';
import { authRoutes } from './routes/authRoutes.js';
import { invoiceRoutes } from './routes/invoiceRoutes.js';
import { userRoutes } from './routes/userRoutes.js';
import { LocalStorageService } from './services/StorageService.js';
import { createOCRService } from './services/OCRService.js';
import { createOpenAIService } from './services/ai/openai.service.js';
import { createGstInvestigationService } from './services/gst/gst.service.js';
import { createUnavailableGstProvider } from './services/gst/unavailable-gst.provider.js';
import { createGstinApiProvider } from './services/gst/gstinapi.provider.js';
import { createTallyVerificationService } from './services/tally/tally.service.js';
import { createMockTallyProvider } from './services/tally/mock-tally.provider.js';
import { createUnavailableTallyProvider } from './services/tally/unavailable-tally.provider.js';
import { createTallyXmlProvider } from './services/tally/tally-xml.provider.js';

export function createApp(config, dependencies = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGIN.split(',').map((origin) => origin.trim()), credentials: false }));
  app.use(express.json({ limit: '1mb' }));
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }), authRoutes(config));
  app.get('/api/auth/me', authenticate(config, dependencies.UserModel), (req, res) => res.json({ userId: req.auth.userId, role: req.auth.role }));
  app.use('/api/users', userRoutes(config, dependencies.UserModel));
  app.use('/api/invoices', invoiceRoutes({
    config,
    storage: dependencies.storage ?? new LocalStorageService(config.STORAGE_DIR ?? './uploads'),
    ocr: dependencies.ocr ?? createOCRService(config),
    aiAnalyzer: dependencies.aiAnalyzer ?? createOpenAIService(config),
    gstService: dependencies.gstService ?? createGstInvestigationService({ provider: dependencies.gstProvider ?? (
      config.GST_VERIFICATION_PROVIDER === 'gstinapi' ? createGstinApiProvider(config) : createUnavailableGstProvider()
    ) }),
    tallyService: dependencies.tallyService ?? createTallyVerificationService({ provider: dependencies.tallyProvider ?? (
      config.TALLY_PROVIDER === 'none' ? createUnavailableTallyProvider() :
        config.TALLY_PROVIDER === 'xml' ? createTallyXmlProvider(config) :
          createMockTallyProvider(config.TALLY_MOCK_RECORDS ?? [])
    ) }),
    InvoiceModel: dependencies.InvoiceModel,
    UserModel: dependencies.UserModel
  }));
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((error, _req, res, _next) => {
    console.error('Request failed:', error.message);
    if (error?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File exceeds the upload size limit' });
    if (error?.code === 'UNSUPPORTED_FILE_TYPE') return res.status(415).json({ error: 'Only PDF, PNG, or JPEG files are supported' });
    if (error?.code === 'LIMIT_UNEXPECTED_FILE' || error?.name === 'MulterError') return res.status(400).json({ error: 'Upload must include one file in the invoice field' });
    return res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}
