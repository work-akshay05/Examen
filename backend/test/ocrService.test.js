import test from 'node:test';
import assert from 'node:assert/strict';
import { createOCRService, OcrUnavailableError } from '../src/services/OCRService.js';

const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

test('OCR.space adapter sends a server-side multipart request and normalizes page results', async () => {
  let request;
  const service = createOCRService({
    OCR_PROVIDER: 'ocr-space', OCR_SPACE_API_KEY: 'test-secret',
    OCR_SPACE_API_URL: 'https://api.ocr.space/parse/image', OCR_SPACE_LANGUAGE: 'eng', OCR_SPACE_ENGINE: '2'
  }, async (url, options) => {
    request = { url, ...options };
    return { ok: true, async json() { return {
      OCRExitCode: 2, IsErroredOnProcessing: false,
      ParsedResults: [
        { FileParseExitCode: 1, ParsedText: 'Invoice Number: A-1\nTotal: 100' },
        { FileParseExitCode: -20, ParsedText: null }
      ]
    }; } };
  });

  const result = await service.extract(image, 'image/png');
  assert.equal(request.url, 'https://api.ocr.space/parse/image');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.apikey, 'test-secret');
  assert.equal(request.body.get('file').name, 'invoice.png');
  assert.equal(request.body.get('language'), 'eng');
  assert.equal(request.body.get('isTable'), 'true');
  assert.equal(request.body.get('OCREngine'), '2');
  assert.equal(result.provider, 'ocr-space');
  assert.equal(result.text, 'Invoice Number: A-1\nTotal: 100');
  assert.deepEqual(result.blocks, [{ page: 1, text: 'Invoice Number: A-1\nTotal: 100' }]);
  assert.ok(result.warnings.length);
});

test('OCR.space missing credentials and malformed/provider error responses fail safely', async () => {
  const unavailable = createOCRService({ OCR_PROVIDER: 'ocr-space' });
  await assert.rejects(unavailable.extract(image, 'image/png'), OcrUnavailableError);

  const malformed = createOCRService({ OCR_PROVIDER: 'ocr-space', OCR_SPACE_API_KEY: 'key' }, async () => ({ ok: true, async json() { return {}; } }));
  await assert.rejects(malformed.extract(image, 'image/png'), /could not process/);

  const httpError = createOCRService({ OCR_PROVIDER: 'ocr-space', OCR_SPACE_API_KEY: 'key' }, async () => ({ ok: false }));
  await assert.rejects(httpError.extract(image, 'image/png'), /request failed/);
});
