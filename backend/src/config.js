import 'dotenv/config';
import { z } from 'zod';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGODB_URI: z.string().min(1).default('mongodb://localhost:27017/invoice-risk'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('8h'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  STORAGE_DIR: z.string().default('./uploads'),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(25).default(1),
  OCR_PROVIDER: z.enum(['none', 'mock', 'ocr-space']).default('ocr-space'),
  OCR_SPACE_API_KEY: z.string().optional(),
  OCR_SPACE_API_URL: z.string().url().default('https://api.ocr.space/parse/image'),
  OCR_SPACE_LANGUAGE: z.string().default('eng'),
  OCR_SPACE_ENGINE: z.enum(['2', '3']).default('2'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().min(1).default('gpt-4.1-mini'),
  GST_VERIFICATION_PROVIDER: z.enum(['none', 'gstinapi']).default('none'),
  GSTINAPI_API_KEY: z.string().optional(),
  GSTINAPI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  TALLY_PROVIDER: z.enum(['mock', 'xml', 'none']).default('mock'),
  TALLY_XML_URL: z.string().url().default('http://127.0.0.1:9000'),
  TALLY_COMPANY_NAME: z.string().optional(),
  TALLY_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  TALLY_MOCK_RECORDS: z.string().default('[]').transform((value, context) => {
    try {
      const records = JSON.parse(value);
      if (!Array.isArray(records) || records.some((record) => !record || typeof record !== 'object' || Array.isArray(record))) throw new Error('expected an array of Tally records');
      return records;
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'TALLY_MOCK_RECORDS must be a JSON array of records' });
      return z.NEVER;
    }
  }),
  ADMIN_NAME: z.string().default('System Admin'),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().optional()
});

export function loadConfig(env = process.env) {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  }
  if (parsed.data.GST_VERIFICATION_PROVIDER === 'gstinapi' && !parsed.data.GSTINAPI_API_KEY) {
    throw new Error('GSTINAPI_API_KEY is required when GST_VERIFICATION_PROVIDER=gstinapi');
  }
  return parsed.data;
}
