export const RISK_POLICY = Object.freeze({
  thresholds: Object.freeze({ lowMax: 30, mediumMax: 60, cap: 100 }),
  points: Object.freeze({
    validation: Object.freeze({ HIGH: 30, MEDIUM: 15, LOW: 5 }),
    gst: Object.freeze({ taxMismatch: 25, gstinInvalid: 20, structureMismatch: 20, externalMismatch: 25, externalUnavailable: 0 }),
    tally: Object.freeze({ amountMismatch: 25, gstinMismatch: 25, vendorMismatch: 20, taxMismatch: 20, invoiceDateMismatch: 15, notFound: 20 }),
    ai: Object.freeze({ HIGH: 20, MEDIUM: 10, LOW: 5 }),
    duplicate: 25
  }),
  manualReview: Object.freeze({ mediumRisk: true, anyHighSeveritySignal: true, duplicateAlways: true, tallyMismatchAlways: true, highGstFindingAlways: true })
});
