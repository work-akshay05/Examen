import { useEffect, useState } from 'react';
import './phase6.css';

async function request(path, token, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers }
  });
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('application/json') ? await response.json().catch(() => ({})) : await response.blob();
  if (!response.ok) {
    if (response.status === 401 && token && body.code === 'ROLE_CHANGED') window.dispatchEvent(new Event('invoice-session-role-changed'));
    throw new Error(body.error ?? 'Request failed');
  }
  return body;
}

function show(value) {
  if (value === null || value === undefined || value === '') return 'Not available';
  if (typeof value === 'number') return value.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  return value;
}

function money(value, currency = 'INR') {
  if (typeof value !== 'number') return show(value);
  const code = currency || 'INR';
  try { return new Intl.NumberFormat('en-IN', { style: 'currency', currency: code, maximumFractionDigits: 2 }).format(value); }
  catch { return `${code} ${show(value)}`; }
}

function invoiceDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return show(value);
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function dateTime(value) {
  return value ? new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}

function Badge({ children, tone = '' }) { return <span className={`status-pill ${tone}`}>{children}</span>; }

function InvoiceDetails({ invoice, token, role, onBack, onValidate, validating, onAnalyze, analyzing, onProcess, processing, onReview, reviewing, onVerify, verifying }) {
  const [comment, setComment] = useState('');
  const [sourceConfirmed, setSourceConfirmed] = useState(false);
  const [sourceComment, setSourceComment] = useState('');
  const [documentUrl, setDocumentUrl] = useState('');
  const [documentError, setDocumentError] = useState('');
  const data = invoice.extractedData ?? {};
  const canReview = ['reviewer', 'admin'].includes(role);
  const hasRisk = invoice.riskAssessment?.assessedAt;
  const needsReview = invoice.riskAssessment?.manualReviewRequired;
  const extractionVerification = invoice.extractionVerification ?? { status: 'PENDING', history: [] };
  const tallyRecord = invoice.tallyVerification?.matchedRecord;
  const tallyComparedFields = tallyRecord ? [
    ['Invoice number', tallyRecord.invoiceNumber], ['Invoice date', tallyRecord.invoiceDate],
    ['Vendor', tallyRecord.vendor?.name], ['GSTIN', tallyRecord.vendor?.gstin],
    ['Taxable amount', tallyRecord.taxableAmount], ['Total amount', tallyRecord.totalAmount],
    ['CGST', tallyRecord.cgst], ['SGST', tallyRecord.sgst], ['IGST', tallyRecord.igst], ['Total tax', tallyRecord.totalTax]
  ].filter(([, value]) => value !== null && value !== undefined && value !== '').map(([label]) => label) : [];

  useEffect(() => {
    let objectUrl;
    let cancelled = false;
    setDocumentUrl(''); setDocumentError('');
    request(`/api/invoices/${invoice._id}/document`, token).then((blob) => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(blob);
      setDocumentUrl(objectUrl);
    }).catch((error) => { if (!cancelled) setDocumentError(error.message || 'Document preview unavailable.'); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [invoice._id, token]);

  async function submitReview(status) {
    if (status === 'APPROVED' && !window.confirm('Are you sure you want to approve this invoice?')) return;
    if (status === 'REJECTED' && !window.confirm('Are you sure you want to reject this invoice?')) return;
    if (status === 'REJECTED' && comment.trim().length < 10) return;
    if (status === 'NEEDS_INFORMATION' && comment.trim().length < 10) return;
    const saved = await onReview(invoice._id, status, comment.trim());
    if (saved) setComment('');
  }

  const detailRows = [
    ['Vendor name', data.vendor?.name], ['Vendor GSTIN', data.vendor?.gstin], ['Vendor address', data.vendor?.address],
    ['Invoice number', data.invoiceNumber], ['Invoice date', invoiceDate(data.invoiceDate)], ['Currency', data.currency ?? 'INR'],
    ['Subtotal', money(data.subtotal, data.currency)], ['Taxable amount', money(data.taxableAmount, data.currency)],
    ['CGST', money(data.cgst, data.currency)], ['SGST', money(data.sgst, data.currency)], ['IGST', money(data.igst, data.currency)],
    ['Total tax', money(data.totalTax, data.currency)], ['Total amount', money(data.totalAmount, data.currency)]
  ];

  return <div className="review-page">
    <button className="text-button back-button" onClick={onBack}>← Back to dashboard</button>
    <section className="panel review-header">
      <div className="review-title"><div><p className="eyebrow">INVOICE REVIEW</p><h1>{data.invoiceNumber ?? invoice.file?.originalName ?? 'Invoice'}</h1><p className="muted-text">{data.vendor?.name ?? 'Vendor unavailable'} · Uploaded {dateTime(invoice.createdAt)}</p></div>
        <div className="header-badges"><Badge tone={invoice.reviewStatus === 'APPROVED' ? 'success' : invoice.reviewStatus === 'REJECTED' ? 'danger' : 'warning'}>{(invoice.reviewStatus ?? 'PENDING').replaceAll('_', ' ')}</Badge>{hasRisk && <Badge tone={invoice.riskAssessment.riskLevel === 'HIGH' ? 'danger' : invoice.riskAssessment.riskLevel === 'MEDIUM' ? 'warning' : 'success'}>{invoice.riskAssessment.riskLevel} · {invoice.riskAssessment.riskScore}/100</Badge>}</div>
      </div>
      {needsReview && <p className="review-required">MANUAL REVIEW REQUIRED</p>}
      <p className="human-loop-note">AI SCREENING → HUMAN DECISION. Risk level is a screening classification and does not determine the final disposition of an invoice.</p>
      {invoice.reviewedAt && <p className="muted-text">Last reviewed by <strong>{invoice.reviewerName ?? 'Reviewer'}</strong> on {dateTime(invoice.reviewedAt)}{invoice.reviewComment ? ` · ${invoice.reviewComment}` : ''}</p>}
    </section>

    <section className="review-layout">
      <div className="review-main">
        {hasRisk && <section className={`panel risk-card risk-${invoice.riskAssessment.riskLevel?.toLowerCase()}`}>
          <p className="eyebrow">EXPLAINABLE SCREENING · NOT A FRAUD DETERMINATION</p><div className="risk-heading"><strong>Risk score: {invoice.riskAssessment.riskScore}/100</strong><Badge tone={invoice.riskAssessment.riskLevel === 'HIGH' ? 'danger' : invoice.riskAssessment.riskLevel === 'MEDIUM' ? 'warning' : 'success'}>{invoice.riskAssessment.riskLevel} risk</Badge></div>
          <p className="risk-review">Manual review: <strong>{needsReview ? 'REQUIRED' : 'NOT REQUIRED'}</strong></p><p>{invoice.riskAssessment.summary}</p><h3>Why this score?</h3>
          {invoice.riskAssessment.signals?.length ? <div className="finding-list">{invoice.riskAssessment.signals.map((signal, index) => <article className="finding" key={`${signal.issueKey}-${index}`}><div className="finding-meta"><span className={`severity severity-${signal.severity?.toLowerCase()}`}>{signal.severity}</span><span>{signal.source}</span><span>+{signal.points} points</span></div><strong>{signal.message}</strong>{signal.evidence && <p>{signal.evidence}</p>}</article>)}</div> : <p className="muted-text">No weighted evidence signals contributed to this score.</p>}
        </section>}

        <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">OCR OUTPUT · NOT VERIFIED</p><h2>Extracted invoice data</h2></div><Badge tone={invoice.extractionStatus === 'COMPLETED' ? 'success' : ''}>{invoice.extractionStatus?.replaceAll('_', ' ') ?? 'Pending'}</Badge></div>
          <div className="details-grid">{detailRows.map(([label, value]) => <div className="detail" key={label}><span>{label}</span><strong>{show(value)}</strong></div>)}</div>
          <div className="source-check subsection"><div className="subsection-heading"><div><h3>Compare with source document</h3><p className="muted-text">Check the invoice number, vendor, GSTIN, date, and amounts against the original before approval.</p></div><a className="small-button link-button" href={documentUrl || undefined} target="_blank" rel="noreferrer" aria-disabled={!documentUrl}>Open source</a></div>
            <div className="source-values">{[['Invoice number', data.invoiceNumber], ['Vendor', data.vendor?.name], ['GSTIN', data.vendor?.gstin], ['Invoice date', invoiceDate(data.invoiceDate)], ['Taxable amount', money(data.taxableAmount, data.currency)], ['CGST', money(data.cgst, data.currency)], ['SGST', money(data.sgst, data.currency)], ['IGST', money(data.igst, data.currency)], ['Total tax', money(data.totalTax, data.currency)], ['Total amount', money(data.totalAmount, data.currency)]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{show(value)}</strong></div>)}</div>
            {extractionVerification.status === 'VERIFIED' ? <p className="success-message">Compared by {extractionVerification.reviewerName ?? 'reviewer'} · {dateTime(extractionVerification.verifiedAt)}. Approval is enabled.</p> : <>
              {extractionVerification.status === 'CORRECTION_REQUIRED' && <p className="notice">Source mismatch flagged by {extractionVerification.reviewerName ?? 'reviewer'}: {extractionVerification.comment}. Request information or resolve this discrepancy before approval.</p>}
              {canReview ? <><label className="source-confirm-label"><input type="checkbox" checked={sourceConfirmed} onChange={(event) => setSourceConfirmed(event.target.checked)} disabled={invoice.extractionStatus !== 'COMPLETED'} /> I compared these extracted values with the original document and they match.</label><button className="small-button" disabled={!sourceConfirmed || verifying || invoice.extractionStatus !== 'COMPLETED'} onClick={() => { onVerify(invoice._id, 'VERIFIED', '').then((saved) => { if (saved) setSourceConfirmed(false); }); }}>{verifying ? 'Saving comparison…' : 'Confirm source comparison'}</button><div className="source-mismatch"><label>Mismatch note<textarea value={sourceComment} onChange={(event) => setSourceComment(event.target.value)} placeholder="Describe what differs from the source" rows={2} /></label><button className="small-button" disabled={verifying || sourceComment.trim().length < 10} onClick={() => { onVerify(invoice._id, 'CORRECTION_REQUIRED', sourceComment.trim()).then((saved) => { if (saved) { setSourceComment(''); setSourceConfirmed(false); } }); }}>{verifying ? 'Saving…' : 'Flag extraction mismatch'}</button></div></> : <p className="muted-text">A reviewer must compare these values with the original document before approval.</p>}
            </>}
            {extractionVerification.history?.length > 0 && <div className="verification-history"><strong>Comparison history</strong>{[...extractionVerification.history].reverse().map((entry) => <p key={entry._id ?? entry.timestamp}>{entry.reviewerName} · {dateTime(entry.timestamp)} · {entry.status.replaceAll('_', ' ')}{entry.comment ? ` · ${entry.comment}` : ''}</p>)}</div>}
          </div>
          <div className="subsection"><h3>Buyer details</h3><div className="details-grid"><div className="detail"><span>Name</span><strong>{show(data.buyer?.name)}</strong></div><div className="detail"><span>GSTIN</span><strong>{show(data.buyer?.gstin)}</strong></div><div className="detail"><span>Address</span><strong>{show(data.buyer?.address)}</strong></div></div></div>
          <div className="subsection"><h3>Line items</h3>{data.lineItems?.length ? <div className="table-wrap"><table className="line-table"><thead><tr><th>Description</th><th>Qty</th><th>Unit price</th><th>Line total</th></tr></thead><tbody>{data.lineItems.map((item, i) => <tr key={i}><td>{show(item.description)}</td><td>{show(item.quantity)}</td><td>{money(item.unitPrice, data.currency)}</td><td>{money(item.amount ?? item.lineTotal, data.currency)}</td></tr>)}</tbody></table></div> : <p className="muted-text">No line items were confidently extracted.</p>}</div>
          {invoice.extractionMetadata?.warnings?.map((warning) => <p className="notice" key={warning}>{warning}</p>)}
        </section>

        <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">SOURCE DOCUMENT</p><h2>{invoice.file?.originalName ?? 'Invoice file'}</h2></div><a className="small-button link-button" href={documentUrl || undefined} target="_blank" rel="noreferrer" aria-disabled={!documentUrl}>Open document</a></div>
          {documentError && <p className="notice">{documentError}</p>}
          {documentUrl && invoice.file?.mimeType === 'application/pdf' && <iframe className="document-frame" src={documentUrl} title="Invoice PDF preview" />}
          {documentUrl && invoice.file?.mimeType?.startsWith('image/') && <img className="document-image" src={documentUrl} alt="Uploaded invoice" />}
        </section>

        <section className="panel evidence-grid">
          <div className="evidence-card"><h2>Deterministic validation</h2>{invoice.validation ? <><div className="validation-summary"><Badge tone={invoice.validation.status === 'PASS' ? 'success' : invoice.validation.status === 'FAIL' ? 'danger' : 'warning'}>{invoice.validation.status}</Badge><span>{invoice.validation.findings?.length ?? 0} findings</span><span>{invoice.validation.summary?.errors ?? 0} errors · {invoice.validation.summary?.warnings ?? 0} warnings</span></div>{invoice.validation.findings?.length ? <div className="finding-list">{invoice.validation.findings.map((finding, index) => <article className="finding" key={`${finding.ruleId}-${index}`}><div className="finding-meta"><span className={`severity severity-${finding.severity?.toLowerCase()}`}>{finding.severity}</span><span>{finding.category}</span></div><strong>{finding.message}</strong><p>{finding.fields?.join(', ')}</p>{(finding.expected !== undefined || finding.actual !== undefined) && <p>Expected: {show(finding.expected)} · Actual: {show(finding.actual)}</p>}</article>)}</div> : <p className="muted-text">No validation findings.</p>}</> : <p className="muted-text">Validation has not been run.</p>}{role !== 'reviewer' && <button className="small-button" disabled={validating || invoice.extractionStatus !== 'COMPLETED'} onClick={() => onValidate(invoice._id)}>{validating ? 'Checking…' : 'Run validation'}</button>}</div>

          <div className="evidence-card"><h2>GST investigation</h2>{invoice.gstInvestigation?.investigatedAt ? <><div className="validation-summary"><Badge tone={invoice.gstInvestigation.formatValid ? 'success' : invoice.gstInvestigation.formatValid === false ? 'danger' : ''}>{invoice.gstInvestigation.formatValid === true ? 'Format valid' : invoice.gstInvestigation.formatValid === false ? 'Invalid format' : 'Format not checked'}</Badge><span>GSTIN: {show(invoice.gstInvestigation.gstin)}</span></div><p className="muted-text">External GST registration: {invoice.gstInvestigation.externalVerificationStatus === 'UNAVAILABLE' ? 'External GST verification unavailable' : invoice.gstInvestigation.externalVerificationStatus === 'VERIFIED' ? 'Externally verified' : invoice.gstInvestigation.externalVerificationStatus?.replaceAll('_', ' ') ?? 'Not checked'} · Provider: {invoice.gstInvestigation.provider}</p>{invoice.gstInvestigation.externalRegistration && <div className="review-field-list"><p><strong>Registered legal name:</strong> {show(invoice.gstInvestigation.externalRegistration.legalName)}</p><p><strong>Trade name:</strong> {show(invoice.gstInvestigation.externalRegistration.tradeName)}</p><p><strong>Registration status:</strong> {show(invoice.gstInvestigation.externalRegistration.status)}</p><p><strong>Taxpayer type:</strong> {show(invoice.gstInvestigation.externalRegistration.taxpayerType)}</p><p><strong>Registration date:</strong> {show(invoice.gstInvestigation.externalRegistration.registrationDate)}</p></div>}{invoice.gstInvestigation.findings?.length ? <div className="finding-list">{invoice.gstInvestigation.findings.map((finding, index) => <article className="finding" key={index}><div className="finding-meta"><span className={`severity severity-${finding.severity?.toLowerCase()}`}>{finding.severity}</span><span>{finding.type}</span></div><strong>{finding.message}</strong><p>{finding.evidence}</p></article>)}</div> : <p className="muted-text">No GST findings.</p>}</> : <p className="muted-text">GST investigation has not been run.</p>}</div>

          <div className="evidence-card"><h2>Tally verification</h2>{invoice.tallyVerification?.verifiedAt ? <><div className="validation-summary"><Badge tone={invoice.tallyVerification.status === 'MATCH' ? 'success' : invoice.tallyVerification.status === 'MISMATCH' ? 'danger' : 'warning'}>{invoice.tallyVerification.status.replaceAll('_', ' ')}</Badge><span>SOURCE: {invoice.tallyVerification.source === 'tally_mock' ? 'MOCK TALLY DATA' : invoice.tallyVerification.source === 'tally_real' ? 'TALLYPRIME XML' : 'UNAVAILABLE'}</span></div>{invoice.tallyVerification.matchedRecordId && <p className="muted-text">Record ID: {invoice.tallyVerification.matchedRecordId}</p>}{tallyRecord && <><p className="muted-text">Matched invoice {show(tallyRecord.invoiceNumber)} · {show(tallyRecord.invoiceDate)}</p><p className="muted-text">Compared fields: {tallyComparedFields.length ? tallyComparedFields.join(', ') : 'No comparable fields returned by source.'}</p></>}{invoice.tallyVerification.differences?.length ? <div className="finding-list">{invoice.tallyVerification.differences.map((difference, index) => <article className="finding" key={index}><div className="finding-meta"><span className={`severity severity-${difference.severity?.toLowerCase()}`}>{difference.severity}</span><span>{difference.field}</span></div><strong>{difference.message}</strong><div className="finding-values"><span>Invoice: {show(difference.invoiceValue)}</span><span>Tally: {show(difference.tallyValue)}</span></div></article>)}</div> : <p className="muted-text">{invoice.tallyVerification.status === 'UNAVAILABLE' ? 'Tally source is unavailable.' : invoice.tallyVerification.status === 'NOT_FOUND' ? 'No matching Tally record was found.' : 'No differences reported.'}</p>}<p className="privacy-note">A discrepancy is a review signal, not a fraud conclusion.</p></> : <p className="muted-text">Tally verification has not been run.</p>}</div>

          <div className="evidence-card"><h2>AI-assisted analysis</h2>{invoice.aiAnalysis?.status === 'COMPLETED' ? <><p>{invoice.aiAnalysis.summary}</p><p className="muted-text">Assessment: {invoice.aiAnalysis.overallAssessment?.replaceAll('_', ' ')} · Model: {invoice.aiAnalysis.model}</p>{invoice.aiAnalysis.anomalies?.length ? <div className="finding-list">{invoice.aiAnalysis.anomalies.map((anomaly, index) => <article className="finding" key={index}><div className="finding-meta"><span className={`severity severity-${anomaly.severity?.toLowerCase()}`}>{anomaly.severity}</span><span>{anomaly.type?.replaceAll('_', ' ')}</span></div><strong>{anomaly.description}</strong><p>Evidence: {anomaly.evidence}</p><p>Reasoning: {anomaly.reasoning}</p><p>Fields: {anomaly.fields?.join(', ')}</p></article>)}</div> : <p className="muted-text">No anomalies identified from supplied data.</p>}</> : <p className="muted-text">{invoice.aiAnalysis?.status === 'FAILED' ? 'AI analysis unavailable. Other evidence remains available for review.' : 'AI analysis has not been run.'}</p>}{role !== 'reviewer' && <button className="small-button" disabled={analyzing || invoice.extractionStatus !== 'COMPLETED'} onClick={() => onAnalyze(invoice._id)}>{analyzing ? 'Analyzing…' : 'Run AI analysis'}</button>}</div>
        </section>
      </div>

      <aside className="review-side">
        <section className="panel review-action-panel"><p className="eyebrow">HUMAN REVIEW</p><h2>Final decision</h2><p className="muted-text">AI screening supports your review. It never approves or rejects an invoice.</p>
          {canReview ? <><label className="review-comment-label">Reviewer comment<textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Add a decision reason or information request" rows={4} /></label><button className="decision-button approve" disabled={reviewing || extractionVerification.status !== 'VERIFIED'} onClick={() => submitReview('APPROVED')}>{reviewing ? 'Saving…' : 'Approve invoice'}</button>{extractionVerification.status !== 'VERIFIED' && <p className="muted-text">Approval is enabled after source comparison is confirmed.</p>}<button className="decision-button needs-info" disabled={reviewing || comment.trim().length < 10} onClick={() => submitReview('NEEDS_INFORMATION')}>Request information</button><button className="decision-button reject" disabled={reviewing || comment.trim().length < 10} onClick={() => submitReview('REJECTED')}>Reject invoice</button><p className="muted-text">Reject and information requests need a clear reason (at least 10 characters). High-risk invoices may still be approved after human review.</p></> : <p className="notice">Your account can view invoices but cannot make reviewer decisions.</p>}
          <div className="review-history"><h3>Review history</h3>{invoice.reviewHistory?.length ? [...invoice.reviewHistory].reverse().map((entry) => <article className="history-entry" key={entry._id ?? `${entry.timestamp}-${entry.newStatus}`}><div className="history-heading"><strong>{entry.reviewerName ?? 'Reviewer'}</strong><span>{dateTime(entry.timestamp)}</span></div><p>Status changed: <b>{entry.previousStatus}</b> → <b>{entry.newStatus}</b></p>{entry.comment && <blockquote>{entry.comment}</blockquote>}</article>) : <p className="muted-text">No review actions recorded. Current status: {invoice.reviewStatus ?? 'PENDING'}.</p>}</div>
        </section>
        {role !== 'reviewer' && <section className="panel process-panel"><p className="eyebrow">SCREENING</p><h2>Refresh evidence</h2><p className="muted-text">Run validation, GST checks, Tally lookup, AI analysis, and risk aggregation.</p><button className="primary-button" disabled={processing || invoice.extractionStatus !== 'COMPLETED'} onClick={() => onProcess(invoice._id)}>{processing ? 'Screening…' : 'Run complete screening'}</button><p className="muted-text">Processing does not make a human review decision.</p></section>}
      </aside>
    </section>
  </div>;
}

function Login({ onLogin, busy, error }) {
  const [mode, setMode] = useState('login');
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  async function submit(event) {
    event.preventDefault();
    await onLogin(mode, { name, email, password });
    setPassword('');
  }
  return <main className="login-shell"><div className="brand"><div className="brand-mark">IR</div><span>Invoice Review</span></div><section className="login-card"><p className="eyebrow">TEAM WORKSPACE</p><h1>{mode === 'register' ? 'Create your account' : 'Sign in to continue'}</h1><p className="muted-text">{mode === 'register' ? 'Create a marketing account to upload invoices.' : 'Screening supports review. People make final decisions.'}</p><form onSubmit={submit} className="login-form">{mode === 'register' && <label>Name<input type="text" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required /></label>}<label>Email<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label><label>Password<input type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} minLength={mode === 'register' ? 12 : undefined} required /></label><button className="primary-button" disabled={busy}>{busy ? 'Please wait…' : mode === 'register' ? 'Create account' : 'Sign in'}</button>{error && <p className="error-message">{error}</p>}</form><button className="text-button auth-switch" onClick={() => setMode(mode === 'register' ? 'login' : 'register')}>{mode === 'register' ? 'Already have an account? Sign in' : 'Need an account? Register'}</button></section></main>;
}

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('invoice-token') ?? '');
  const [role, setRole] = useState(() => localStorage.getItem('invoice-role') ?? 'marketing');
  const [file, setFile] = useState(null); const [invoices, setInvoices] = useState([]); const [selected, setSelected] = useState(null);
  const [summary, setSummary] = useState({ total: 0, pendingReview: 0, highRisk: 0, mediumRisk: 0, lowRisk: 0, approved: 0, rejected: 0 });
  const [page, setPage] = useState(1); const [pageSize] = useState(25); const [totalPages, setTotalPages] = useState(0); const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({ search: '', riskLevel: '', reviewStatus: '', processingStatus: '', manualReviewRequired: '', from: '', to: '' });
  const [appliedFilters, setAppliedFilters] = useState({}); const [view, setView] = useState('dashboard');
  const [users, setUsers] = useState([]); const [usersLoading, setUsersLoading] = useState(false); const [updatingUserId, setUpdatingUserId] = useState('');
  const [busy, setBusy] = useState(false); const [validating, setValidating] = useState(false); const [analyzing, setAnalyzing] = useState(false); const [processing, setProcessing] = useState(false); const [reviewing, setReviewing] = useState(false); const [verifying, setVerifying] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');

  async function loadDashboard(activeToken = token, currentPage = page, currentFilters = appliedFilters) {
    const params = new URLSearchParams({ page: String(currentPage), pageSize: String(pageSize) });
    Object.entries(currentFilters).forEach(([key, value]) => { if (value) params.set(key, value); });
    const result = await request(`/api/invoices?${params.toString()}`, activeToken);
    setInvoices(result.invoices); setSummary(result.summary); setTotal(result.total); setTotalPages(result.totalPages);
  }

  useEffect(() => {
    if (token) request('/api/auth/me', token).then((me) => {
      setRole(me.role); localStorage.setItem('invoice-role', me.role);
      return loadDashboard();
    }).catch((e) => { setError(e.message); if (e.message.includes('token')) signOut(); });
  }, [token, page, appliedFilters]);

  useEffect(() => {
    const handleRoleChanged = () => signOut();
    window.addEventListener('invoice-session-role-changed', handleRoleChanged);
    return () => window.removeEventListener('invoice-session-role-changed', handleRoleChanged);
  }, []);

  function signOut() {
    localStorage.removeItem('invoice-token'); localStorage.removeItem('invoice-role');
    setToken(''); setRole('marketing'); setInvoices([]); setSelected(null); setView('dashboard');
  }

  async function login(mode, credentials) {
    setBusy(true); setError('');
    try {
      const result = await request(mode === 'register' ? '/api/auth/register' : '/api/auth/login', '', { method: 'POST', body: JSON.stringify(credentials) });
      localStorage.setItem('invoice-token', result.token); localStorage.setItem('invoice-role', result.user.role); setRole(result.user.role); setToken(result.token);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function openInvoice(id) {
    setError('');
    try { setSelected((await request(`/api/invoices/${id}`, token)).invoice); setView('detail'); }
    catch (e) { setError(e.message); }
  }

  async function refreshSelected(id = selected?._id) {
    await loadDashboard();
    if (id) setSelected((await request(`/api/invoices/${id}`, token)).invoice);
  }

  async function upload(event) {
    event.preventDefault(); const uploadForm = event.currentTarget; if (!file) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const formData = new FormData(); formData.append('invoice', file);
      const result = await request('/api/invoices', token, { method: 'POST', body: formData });
      setSelected(result.invoice); setFile(null); setView('detail'); await loadDashboard();
      uploadForm.reset();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function runAction(setBusyState, action, id) {
    setBusyState(true); setError('');
    try { const result = await action(); if (result?.invoice) setSelected(result.invoice); else await refreshSelected(id); await loadDashboard(); }
    catch (e) { setError(e.message); } finally { setBusyState(false); }
  }
  const runValidation = (id) => runAction(setValidating, () => request(`/api/invoices/${id}/validate`, token, { method: 'POST' }), id);
  const runAnalysis = (id) => runAction(setAnalyzing, () => request(`/api/invoices/${id}/analyze`, token, { method: 'POST' }), id);
  const runProcessing = (id) => runAction(setProcessing, () => request(`/api/invoices/${id}/process`, token, { method: 'POST' }), id);

  async function reviewInvoice(id, status, comment) {
    setReviewing(true); setError(''); setNotice('');
    try {
      await request(`/api/invoices/${id}/review`, token, { method: 'POST', body: JSON.stringify({ status, comment }) });
      await refreshSelected(id); setNotice(`Invoice marked ${status.replaceAll('_', ' ').toLowerCase()}. Review history updated.`);
      return true;
    } catch (e) { setError(e.message); return false; } finally { setReviewing(false); }
  }

  async function verifyExtraction(id, status, comment) {
    setVerifying(true); setError(''); setNotice('');
    try {
      await request(`/api/invoices/${id}/verify-extraction`, token, { method: 'POST', body: JSON.stringify({ status, comment }) });
      await refreshSelected(id);
      setNotice(status === 'VERIFIED' ? 'Source comparison recorded. Human approval is now available.' : 'Extraction mismatch recorded. Resolve the discrepancy before approval.');
      return true;
    } catch (e) { setError(e.message); return false; } finally { setVerifying(false); }
  }

  async function loadUsers() {
    setUsersLoading(true); setError('');
    try { setUsers((await request('/api/users', token)).users); }
    catch (e) { setError(e.message); }
    finally { setUsersLoading(false); }
  }

  async function updateUserRole(user, newRole) {
    if (user.role === newRole) return;
    setUpdatingUserId(user.id); setError(''); setNotice('');
    try {
      const result = await request(`/api/users/${user.id}/role`, token, { method: 'PATCH', body: JSON.stringify({ role: newRole }) });
      setUsers((current) => current.map((entry) => entry.id === user.id ? result.user : entry));
      setNotice(`${user.name}'s role updated to ${newRole}.`);
    } catch (e) { setError(e.message); }
    finally { setUpdatingUserId(''); }
  }

  if (!token) return <Login onLogin={login} busy={busy} error={error} />;

  return <main className="app-shell"><header className="topbar"><button className="brand brand-button" onClick={() => setView('dashboard')}><span className="brand-mark">IR</span><span><strong>Invoice Review</strong><small>AI screening → human decision</small></span></button><div className="topbar-actions">{role === 'admin' && <button className="text-button" onClick={() => { setView('users'); setError(''); setNotice(''); loadUsers(); }}>Manage users</button>}<Badge>{role.toUpperCase()}</Badge><button className="text-button" onClick={signOut}>Sign out</button></div></header>
    {view === 'users' && role === 'admin' ? <><div className="feedback-row">{error && <p className="error-message">{error}</p>}{notice && <p className="success-message">{notice}</p>}</div><UserManagement users={users} loading={usersLoading} updatingId={updatingUserId} onRoleChange={updateUserRole} onRefresh={loadUsers} /></> :
    view === 'detail' && selected ? <><div className="feedback-row">{error && <p className="error-message">{error}</p>}{notice && <p className="success-message">{notice}</p>}</div><InvoiceDetails key={selected._id} invoice={selected} token={token} role={role} onBack={() => { setView('dashboard'); setNotice(''); }} onValidate={runValidation} validating={validating} onAnalyze={runAnalysis} analyzing={analyzing} onProcess={runProcessing} processing={processing} onReview={reviewInvoice} reviewing={reviewing} onVerify={verifyExtraction} verifying={verifying} /></> : <>
      <section className="welcome dashboard-welcome"><div><p className="eyebrow">INVOICE OPERATIONS</p><h1>Review dashboard</h1><p>Screening prioritizes attention. Human reviewers make final decisions.</p></div>{role !== 'reviewer' && <form className="upload-inline" onSubmit={upload}><label><span>Upload invoice</span><input type="file" accept="application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label><button className="primary-button" disabled={!file || busy}>{busy ? 'Uploading…' : 'Upload'}</button></form>}</section>
      {error && <p className="error-message">{error}</p>}{notice && <p className="success-message">{notice}</p>}
      <section className="summary-grid"><SummaryCard title="Total invoices" value={summary.total} /><SummaryCard title="Pending review" value={summary.pendingReview} tone="warning" /><SummaryCard title="High risk" value={summary.highRisk} tone="danger" /><SummaryCard title="Medium risk" value={summary.mediumRisk} tone="warning" /><SummaryCard title="Low risk" value={summary.lowRisk} tone="success" /><SummaryCard title="Approved" value={summary.approved} tone="success" /><SummaryCard title="Rejected" value={summary.rejected} tone="danger" /></section>
      <section className="panel dashboard-panel"><div className="panel-heading"><div><p className="eyebrow">LIVE INVOICE DATA</p><h2>Invoices <span className="result-count">{total}</span></h2></div><button className="small-button" onClick={() => loadDashboard().catch((e) => setError(e.message))}>Refresh</button></div>
        <form className="filter-bar" onSubmit={(e) => { e.preventDefault(); setPage(1); setAppliedFilters(filters); }}><input aria-label="Search invoices" placeholder="Search number, vendor, GSTIN" value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} /><select aria-label="Risk level" value={filters.riskLevel} onChange={(e) => setFilters({ ...filters, riskLevel: e.target.value })}><option value="">All risk levels</option><option>HIGH</option><option>MEDIUM</option><option>LOW</option></select><select aria-label="Review status" value={filters.reviewStatus} onChange={(e) => setFilters({ ...filters, reviewStatus: e.target.value })}><option value="">All review statuses</option><option>PENDING</option><option>APPROVED</option><option>REJECTED</option><option value="NEEDS_INFORMATION">NEEDS INFORMATION</option></select><select aria-label="Processing status" value={filters.processingStatus} onChange={(e) => setFilters({ ...filters, processingStatus: e.target.value })}><option value="">All processing</option><option>EXTRACTION_COMPLETED</option><option>OCR_FAILED</option><option>EXTRACTION_FAILED</option><option>UPLOADED</option></select><select aria-label="Manual review required" value={filters.manualReviewRequired} onChange={(e) => setFilters({ ...filters, manualReviewRequired: e.target.value })}><option value="">Any manual review</option><option value="true">Required</option><option value="false">Not required</option></select><input aria-label="Created from" type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /><input aria-label="Created through" type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /><button className="small-button" type="submit">Apply filters</button><button className="text-button" type="button" onClick={() => { const empty = { search: '', riskLevel: '', reviewStatus: '', processingStatus: '', manualReviewRequired: '', from: '', to: '' }; setFilters(empty); setAppliedFilters(empty); setPage(1); }}>Clear</button></form>
        {invoices.length ? <div className="table-wrap"><table className="invoice-table"><thead><tr><th>Invoice</th><th>Vendor / GSTIN</th><th>Date</th><th>Total</th><th>Risk</th><th>Manual review</th><th>Processing</th><th>Review</th><th>Created</th><th>Reviewer</th></tr></thead><tbody>{invoices.map((invoice) => { const data = invoice.extractedData ?? {}; return <tr key={invoice._id} onClick={() => openInvoice(invoice._id)} tabIndex="0" onKeyDown={(e) => { if (e.key === 'Enter') openInvoice(invoice._id); }}><td><strong>{data.invoiceNumber ?? invoice.file?.originalName ?? 'Invoice'}</strong><small>{invoice.file?.originalName}</small></td><td>{data.vendor?.name ?? '—'}<small>{data.vendor?.gstin ?? 'GSTIN unavailable'}</small></td><td>{invoiceDate(data.invoiceDate)}</td><td>{money(data.totalAmount, data.currency)}</td><td>{invoice.riskAssessment?.riskLevel ? <Badge tone={invoice.riskAssessment.riskLevel === 'HIGH' ? 'danger' : invoice.riskAssessment.riskLevel === 'MEDIUM' ? 'warning' : 'success'}>{invoice.riskAssessment.riskLevel} {invoice.riskAssessment.riskScore ?? ''}</Badge> : '—'}</td><td><Badge tone={invoice.riskAssessment?.manualReviewRequired ? 'warning' : ''}>{invoice.riskAssessment?.manualReviewRequired ? 'REQUIRED' : invoice.riskAssessment?.assessedAt ? 'NOT REQUIRED' : '—'}</Badge></td><td>{(invoice.processingStatus ?? 'UPLOADED').replaceAll('_', ' ')}</td><td><Badge tone={invoice.reviewStatus === 'APPROVED' ? 'success' : invoice.reviewStatus === 'REJECTED' ? 'danger' : 'warning'}>{(invoice.reviewStatus ?? 'PENDING').replaceAll('_', ' ')}</Badge></td><td>{dateTime(invoice.createdAt)}</td><td>{invoice.reviewerName ?? '—'}</td></tr>; })}</tbody></table></div> : <div className="empty-dashboard"><h2>{total ? 'No invoices match these filters' : 'No invoices yet'}</h2><p>{total ? 'Change or clear the filters to see other invoices.' : 'Upload an invoice to start screening and human review.'}</p></div>}
        <div className="pagination"><span>Page {page} of {Math.max(1, totalPages)} · {total} invoices</span><div><button className="small-button" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><button className="small-button" disabled={!totalPages || page >= totalPages} onClick={() => setPage(page + 1)}>Next</button></div></div>
      </section>
      <footer>Risk level is a screening classification and does not determine the final disposition of an invoice.</footer>
    </>}
  </main>;
}

function SummaryCard({ title, value, tone = '' }) {
  return <article className={`summary-card ${tone}`}><span>{title}</span><strong>{value ?? 0}</strong></article>;
}

function UserManagement({ users, loading, updatingId, onRoleChange, onRefresh }) {
  return <section className="panel dashboard-panel user-management">
    <div className="panel-heading"><div><p className="eyebrow">ACCESS CONTROL</p><h2>User management <span className="result-count">{users.length}</span></h2></div><button className="small-button" onClick={onRefresh} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button></div>
    <p className="muted-text">Admins cannot be changed here, and you cannot change your own role.</p>
    {loading && !users.length ? <p className="muted-text">Loading users…</p> : <div className="table-wrap"><table className="invoice-table user-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Action</th></tr></thead><tbody>{users.map((user) => <tr key={user.id}><td><strong>{user.name}</strong></td><td>{user.email}</td><td><Badge>{user.role.toUpperCase()}</Badge></td><td>{user.role === 'admin' ? <span className="muted-text">Protected</span> : <select aria-label={`Role for ${user.name}`} value={user.role} disabled={updatingId === user.id} onChange={(event) => onRoleChange(user, event.target.value)}><option value="marketing">Marketing</option><option value="reviewer">Reviewer</option></select>}</td></tr>)}</tbody></table></div>}
  </section>;
}
