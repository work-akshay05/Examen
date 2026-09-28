export class OcrUnavailableError extends Error {
  constructor() {
    super('OCR provider is not configured');
    this.name = 'OcrUnavailableError';
  }
}

function createOcrSpaceService(config, fetchImpl) {
  return {
    async extract(buffer, mimeType) {
      if (!config.OCR_SPACE_API_KEY) throw new OcrUnavailableError();
      const form = new FormData();
      const filename = mimeType === 'application/pdf' ? 'invoice.pdf' : mimeType === 'image/png' ? 'invoice.png' : 'invoice.jpg';
      form.append('file', new Blob([buffer], { type: mimeType }), filename);
      form.append('language', config.OCR_SPACE_LANGUAGE ?? 'eng');
      form.append('isTable', 'true');
      form.append('isOverlayRequired', 'false');
      form.append('OCREngine', config.OCR_SPACE_ENGINE ?? '2');

      const response = await fetchImpl(config.OCR_SPACE_API_URL ?? 'https://api.ocr.space/parse/image', {
        method: 'POST', headers: { apikey: config.OCR_SPACE_API_KEY }, body: form,
        signal: AbortSignal.timeout(60_000)
      });
      if (!response.ok) throw new Error('OCR.space request failed');

      let payload;
      try { payload = await response.json(); }
      catch { throw new Error('OCR.space returned malformed output'); }
      const parsedResults = payload?.ParsedResults;
      if (!Array.isArray(parsedResults) || payload.IsErroredOnProcessing === true || ![1, 2, '1', '2'].includes(payload.OCRExitCode)) {
        throw new Error('OCR.space could not process this document');
      }

      const blocks = parsedResults
        .filter((page) => String(page?.FileParseExitCode) === '1' && typeof page.ParsedText === 'string')
        .map((page, index) => ({ page: index + 1, text: page.ParsedText.trim() }))
        .filter((page) => page.text.length > 0);
      if (blocks.length === 0) throw new Error('OCR.space returned no recognized text');
      const warnings = [2, '2'].includes(payload.OCRExitCode) ? ['OCR.space only recognized part of the document.'] : [];
      return { text: blocks.map((page) => page.text).join('\n\n'), blocks, provider: 'ocr-space', isMock: false, warnings };
    }
  };
}

export function createOCRService(config, fetchImpl = fetch) {
  if (config.OCR_PROVIDER === 'ocr-space') return createOcrSpaceService(config, fetchImpl);
  return {
    async extract() {
      if (config.OCR_PROVIDER === 'mock') return { text: '', blocks: [], provider: 'mock', isMock: true };
      throw new OcrUnavailableError();
    }
  };
}
