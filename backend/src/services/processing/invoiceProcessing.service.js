import { validateInvoiceWithDuplicates } from '../validation/validation.service.js';
import { AiAnalysisError, AiUnavailableError } from '../ai/openai.service.js';
import { assessRisk } from '../risk/risk.service.js';

export async function processInvoice(invoice, { InvoiceModel, gstService, tallyService, aiAnalyzer, aiModel = null, now = new Date() } = {}) {
  const validation = await validateInvoiceWithDuplicates(invoice.extractedData, { now, InvoiceModel, excludeInvoiceId: invoice._id });
  validation.validatedAt = now;
  invoice.validation = validation;
  await invoice.save();

  try {
    invoice.gstInvestigation = await gstService.investigate(invoice.extractedData, validation);
  } catch {
    invoice.gstInvestigation = { status: 'UNAVAILABLE', provider: 'none', externalVerificationStatus: 'UNAVAILABLE', gstin: null, formatValid: null, impliedTaxRatePercent: null, findings: [{ type: 'GST_INVESTIGATION_UNAVAILABLE', severity: 'LOW', message: 'GST investigation service is unavailable.', evidence: '', fields: [] }], investigatedAt: new Date() };
  }
  await invoice.save();

  try {
    invoice.tallyVerification = await tallyService.verify(invoice.extractedData);
  } catch {
    invoice.tallyVerification = { status: 'UNAVAILABLE', source: 'none', matchedRecordId: null, differences: [], verifiedAt: new Date() };
  }
  await invoice.save();

  invoice.aiAnalysis = { status: 'PROCESSING', summary: null, anomalies: [], overallAssessment: null, model: null, analyzedAt: null, error: null };
  await invoice.save();
  try {
    const result = await aiAnalyzer.analyze(invoice);
    invoice.aiAnalysis = { status: 'COMPLETED', ...result, model: aiModel, analyzedAt: new Date(), error: null };
  } catch (error) {
    invoice.aiAnalysis = {
      status: 'FAILED', summary: null, anomalies: [], overallAssessment: null,
      model: aiModel, analyzedAt: null,
      error: error instanceof AiUnavailableError ? 'OpenAI API key is not configured.' : error instanceof AiAnalysisError ? error.userMessage : 'AI analysis failed. Available screening checks were still completed.'
    };
  }
  await invoice.save();

  invoice.riskAssessment = assessRisk({
    validation: invoice.validation,
    gstInvestigation: invoice.gstInvestigation,
    tallyVerification: invoice.tallyVerification,
    aiAnalysis: invoice.aiAnalysis
  }, { assessedAt: new Date() });
  await invoice.save();
  return {
    invoice,
    validation: invoice.validation,
    gstInvestigation: invoice.gstInvestigation,
    tallyVerification: invoice.tallyVerification,
    aiAnalysis: invoice.aiAnalysis,
    riskAssessment: invoice.riskAssessment
  };
}
