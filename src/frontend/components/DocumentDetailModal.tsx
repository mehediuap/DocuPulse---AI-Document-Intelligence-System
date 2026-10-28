import React, { useState } from 'react';
import {
  DocumentResultResponse,
  DocumentMetadataResponse,
  JobStatus,
  AuditEntry,
} from '../../services/api/types.ts';
import {
  X,
  RotateCw,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  Layers,
  Edit3,
  FileText,
  DollarSign,
  Calendar,
  Building,
  User,
  Hash,
  List,
  Save,
  ShieldAlert,
  History,
  Loader2,
  Info,
} from 'lucide-react';

interface DocumentDetailModalProps {
  metadata: DocumentMetadataResponse | null;
  result: DocumentResultResponse | null;
  isLoading: boolean;
  onClose: () => void;
  onRetry: (documentId: string) => Promise<void>;
  onApplyCorrection: (
    documentId: string,
    corrections: Record<string, any>,
    reason: string,
    revalidate: boolean
  ) => Promise<void>;
}

export const DocumentDetailModal: React.FC<DocumentDetailModalProps> = ({
  metadata,
  result,
  isLoading,
  onClose,
  onRetry,
  onApplyCorrection,
}) => {
  const [activeTab, setActiveTab] = useState<'extraction' | 'validation' | 'correction' | 'audit'>('extraction');
  const [selectedField, setSelectedField] = useState<string>('invoice_number');
  const [correctionValue, setCorrectionValue] = useState<string>('');
  const [correctionReason, setCorrectionReason] = useState<string>('');
  const [revalidateOnSave, setRevalidateOnSave] = useState<boolean>(true);
  const [isSavingCorrection, setIsSavingCorrection] = useState<boolean>(false);
  const [correctionSuccessMsg, setCorrectionSuccessMsg] = useState<string | null>(null);
  const [correctionErrorMsg, setCorrectionErrorMsg] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState<boolean>(false);

  if (!metadata) return null;

  const extraction = result?.extraction;
  const validation = result?.validation;
  const auditTrail = result?.auditTrail || [];
  const status = result?.status || metadata.status;

  const handleRetry = async () => {
    setIsRetrying(true);
    try {
      await onRetry(metadata.id);
    } finally {
      setIsRetrying(false);
    }
  };

  const handleSaveCorrection = async (e: React.FormEvent) => {
    e.preventDefault();
    setCorrectionErrorMsg(null);
    setCorrectionSuccessMsg(null);

    if (!selectedField) {
      setCorrectionErrorMsg('Please select a field to correct.');
      return;
    }

    if (!correctionReason.trim()) {
      setCorrectionErrorMsg('An audit justification / reason is required for manual corrections.');
      return;
    }

    setIsSavingCorrection(true);
    try {
      // Parse numeric fields safely
      let parsedValue: any = correctionValue;
      if (['subtotal', 'tax', 'total'].includes(selectedField)) {
        const num = parseFloat(correctionValue);
        if (isNaN(num)) {
          throw new Error(`Field "${selectedField}" must be a valid number.`);
        }
        parsedValue = num;
      }

      await onApplyCorrection(
        metadata.id,
        { [selectedField]: parsedValue },
        correctionReason.trim(),
        revalidateOnSave
      );

      setCorrectionSuccessMsg(`Field "${selectedField}" updated successfully.`);
      setCorrectionValue('');
      setCorrectionReason('');
    } catch (err: any) {
      setCorrectionErrorMsg(err.message || 'Failed to apply manual correction.');
    } finally {
      setIsSavingCorrection(false);
    }
  };

  const getCurrentFieldValue = (field: string) => {
    if (!extraction) return '—';
    const val = (extraction as any)[field];
    return val !== undefined && val !== null ? String(val) : '—';
  };

  const formatAmount = (value: number | null | undefined) => {
    if (value === null || value === undefined) return '—';
    if (!extraction?.currency) {
      return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: extraction.currency,
    }).format(value);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-2 backdrop-blur-sm sm:p-4">
      <div className="flex max-h-[94vh] w-full max-w-5xl animate-in flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-2xl duration-150 fade-in sm:max-h-[90vh] sm:rounded-3xl">
        {/* Header Bar */}
        <div className="flex items-center justify-between gap-3 border-b border-indigo-400/20 bg-gradient-to-r from-indigo-700 via-blue-700 to-indigo-800 px-4 py-4 text-white sm:px-6">
          <div className="min-w-0 flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/15 bg-white/10 text-white shadow-inner">
              <FileText className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="truncate text-sm font-bold text-white">
                  {metadata.sanitizedFilename}
                </h3>
                {status === 'completed' && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200/60 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 shadow-2xs">
                    <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                    Valid
                  </span>
                )}
                {status === 'needs_review' && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200/60 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
                    <AlertTriangle className="h-3 w-3 text-amber-600" />
                    Needs Review
                  </span>
                )}
                {status === 'invalid' && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-200/60 bg-rose-50 px-3 py-1 text-xs font-semibold text-rose-700">
                    <XCircle className="h-3 w-3 text-rose-600" />
                    Invalid
                  </span>
                )}
                {status === 'failed' && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-200/60 bg-rose-50 px-3 py-1 text-xs font-semibold text-rose-700">
                    <XCircle className="h-3 w-3 text-rose-600" />
                    Failed
                  </span>
                )}
                {(status === 'queued' || status === 'processing') && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo-200/70 bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">
                    <Loader2 className="h-3 w-3 animate-spin text-indigo-600" />
                    {status === 'queued' ? 'Queued' : 'Processing'}
                  </span>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-indigo-100">
                <span>ID: {metadata.id}</span>
                <span>·</span>
                <span className="uppercase">{metadata.fileType}</span>
                <span>·</span>
                <span>Attempts: {metadata.retryCount + 1}</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {(status === 'failed' || status === 'needs_review') && (
              <button
                onClick={handleRetry}
                disabled={isRetrying}
                className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-xl border border-white/20 bg-white/10 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-white/20 disabled:opacity-50"
              >
                <RotateCw className={`w-3.5 h-3.5 ${isRetrying ? 'animate-spin' : ''}`} />
                <span>{isRetrying ? 'Retrying...' : 'Retry Job'}</span>
              </button>
            )}
            <button
              onClick={onClose}
              className="cursor-pointer rounded-xl p-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Modal Tabs */}
        <div className="flex items-center gap-4 overflow-x-auto border-b border-slate-200/80 bg-white px-4 text-xs font-medium text-slate-600 sm:gap-6 sm:px-6">
          <button
            onClick={() => setActiveTab('extraction')}
            className={`flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap border-b-2 py-3 transition-colors ${
              activeTab === 'extraction'
                ? 'border-indigo-600 text-indigo-700 font-semibold'
                : 'border-transparent hover:text-slate-900'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Extracted Information</span>
          </button>

          <button
            onClick={() => setActiveTab('validation')}
            className={`flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap border-b-2 py-3 transition-colors ${
              activeTab === 'validation'
                ? 'border-indigo-600 text-indigo-700 font-semibold'
                : 'border-transparent hover:text-slate-900'
            }`}
          >
            <ShieldAlert className="w-3.5 h-3.5" />
            <span>Validation & Rules ({validation?.issues.length || 0})</span>
          </button>

          <button
            onClick={() => setActiveTab('correction')}
            className={`flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap border-b-2 py-3 transition-colors ${
              activeTab === 'correction'
                ? 'border-indigo-600 text-indigo-700 font-semibold'
                : 'border-transparent hover:text-slate-900'
            }`}
          >
            <Edit3 className="w-3.5 h-3.5" />
            <span>Manual Correction</span>
          </button>

          <button
            onClick={() => setActiveTab('audit')}
            className={`flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap border-b-2 py-3 transition-colors ${
              activeTab === 'audit'
                ? 'border-indigo-600 text-indigo-700 font-semibold'
                : 'border-transparent hover:text-slate-900'
            }`}
          >
            <History className="w-3.5 h-3.5" />
            <span>Audit Trail ({auditTrail.length})</span>
          </button>
        </div>

        {/* Modal Body */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          {isLoading && !result ? (
            <div className="py-20 text-center text-slate-500">
              <Loader2 className="w-8 h-8 animate-spin mx-auto text-indigo-600 mb-3" />
              <div className="font-semibold text-slate-800">Retrieving Document Intelligence...</div>
              <div className="text-xs text-slate-400 mt-1">Connecting to SQLite state and processing queue...</div>
            </div>
          ) : status === 'queued' || status === 'processing' ? (
            <div className="py-16 text-center text-slate-600 max-w-md mx-auto">
              <div className="w-12 h-12 rounded-full bg-indigo-50 border border-indigo-200 flex items-center justify-center mx-auto mb-4 text-indigo-600">
                <Loader2 className="w-6 h-6 animate-spin" />
              </div>
              <h4 className="font-semibold text-slate-900 text-sm">Processing Pipeline in Progress</h4>
              <p className="text-xs text-slate-500 mt-1">
                Document is currently progressing through layout segmentation, OCR, AI extraction, and financial reconciliation.
              </p>
              <div className="mt-4 p-3 bg-slate-50 rounded border border-slate-200 text-xs text-slate-600 font-mono">
                Status: {status.toUpperCase()} · Auto-polling enabled
              </div>
            </div>
          ) : status === 'failed' ? (
            <div className="p-6 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-900 flex flex-col gap-3">
              <div className="flex items-center gap-2 font-semibold text-sm text-rose-800">
                <XCircle className="w-5 h-5 text-rose-600 shrink-0" />
                <span>Document Ingestion or Extraction Failed</span>
              </div>
              <p className="text-slate-700">
                The pipeline encountered a fatal error during stream decoding or parsing. Fault isolation prevented this failure from cascading to other files.
              </p>
              {result?.errors && result.errors.length > 0 && (
                <div className="bg-white/80 p-3 rounded border border-rose-200 font-mono text-[11px] text-rose-700">
                  {result.errors.map((err, i) => (
                    <div key={i}>• {err}</div>
                  ))}
                </div>
              )}
              <div className="pt-2">
                <button
                  onClick={handleRetry}
                  disabled={isRetrying}
                  className="px-4 py-2 bg-rose-600 text-white rounded font-medium hover:bg-rose-700 transition-colors flex items-center gap-2 cursor-pointer"
                >
                  <RotateCw className={`w-3.5 h-3.5 ${isRetrying ? 'animate-spin' : ''}`} />
                  <span>Retry Ingestion Job</span>
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* TAB 1: Extracted Information */}
              {activeTab === 'extraction' && (
                <div className="flex flex-col gap-6">
                  {/* Key Financial Fields Grid */}
                  <div>
                    <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
                      Core Invoice Entities
                    </h4>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-xs transition-shadow hover:shadow-sm">
                        <div className="text-[11px] text-slate-500 flex items-center gap-1">
                          <Hash className="w-3 h-3 text-slate-400" />
                          <span>Invoice Number</span>
                        </div>
                        <div className="font-mono font-semibold text-sm text-slate-900 mt-1">
                          {extraction?.invoice_number || <span className="text-slate-400 italic font-normal">null</span>}
                        </div>
                      </div>

                      <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-xs transition-shadow hover:shadow-sm">
                        <div className="text-[11px] text-slate-500 flex items-center gap-1">
                          <Calendar className="w-3 h-3 text-slate-400" />
                          <span>Invoice Date</span>
                        </div>
                        <div className="font-mono font-semibold text-sm text-slate-900 mt-1">
                          {extraction?.invoice_date || <span className="text-slate-400 italic font-normal">null</span>}
                        </div>
                      </div>

                      <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-xs transition-shadow hover:shadow-sm">
                        <div className="text-[11px] text-slate-500 flex items-center gap-1">
                          <DollarSign className="w-3 h-3 text-slate-400" />
                          <span>Currency</span>
                        </div>
                        <div className="font-mono font-semibold text-sm text-slate-900 mt-1">
                          {extraction?.currency || <span className="text-slate-400 italic font-normal">null</span>}
                        </div>
                      </div>

                      <div className="rounded-2xl border border-indigo-200/70 bg-gradient-to-br from-indigo-50 to-white p-4 shadow-sm shadow-indigo-100/70">
                        <div className="text-[11px] text-indigo-700 flex items-center gap-1 font-medium">
                          <DollarSign className="w-3 h-3 text-indigo-600" />
                          <span>Total Amount</span>
                        </div>
                        <div className="font-mono font-bold text-base text-indigo-950 mt-1">
                          {extraction?.total !== null && extraction?.total !== undefined
                            ? formatAmount(extraction.total)
                            : <span className="text-slate-400 italic font-normal">null</span>}
                        </div>
                      </div>

                      <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-xs transition-shadow hover:shadow-sm">
                        <div className="text-[11px] text-slate-500 flex items-center gap-1">
                          <Building className="w-3 h-3 text-slate-400" />
                          <span>Supplier Name</span>
                        </div>
                        <div className="font-medium text-xs text-slate-900 mt-1 truncate">
                          {extraction?.supplier_name || <span className="text-slate-400 italic font-normal">null</span>}
                        </div>
                      </div>

                      <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-xs transition-shadow hover:shadow-sm">
                        <div className="text-[11px] text-slate-500 flex items-center gap-1">
                          <User className="w-3 h-3 text-slate-400" />
                          <span>Customer Name</span>
                        </div>
                        <div className="font-medium text-xs text-slate-900 mt-1 truncate">
                          {extraction?.customer_name || <span className="text-slate-400 italic font-normal">null</span>}
                        </div>
                      </div>

                      <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-xs transition-shadow hover:shadow-sm">
                        <div className="text-[11px] text-slate-500 flex items-center gap-1">
                          <DollarSign className="w-3 h-3 text-slate-400" />
                          <span>Subtotal</span>
                        </div>
                        <div className="font-mono font-semibold text-xs text-slate-900 mt-1">
                          {extraction?.subtotal !== null && extraction?.subtotal !== undefined
                            ? formatAmount(extraction.subtotal)
                            : <span className="text-slate-400 italic font-normal">null</span>}
                        </div>
                      </div>

                      <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-xs transition-shadow hover:shadow-sm">
                        <div className="text-[11px] text-slate-500 flex items-center gap-1">
                          <DollarSign className="w-3 h-3 text-slate-400" />
                          <span>Tax Amount</span>
                        </div>
                        <div className="font-mono font-semibold text-xs text-slate-900 mt-1">
                          {extraction?.tax !== null && extraction?.tax !== undefined
                            ? formatAmount(extraction.tax)
                            : <span className="text-slate-400 italic font-normal">null</span>}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Line Items Table */}
                  <div>
                    <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3 flex items-center justify-between">
                      <span>Line Items ({extraction?.line_items?.length || 0})</span>
                      <span className="text-[11px] font-mono lowercase font-normal text-slate-400">
                        Decimal-safe integer cents reconciliation
                      </span>
                    </h4>

                    {extraction?.line_items && extraction.line_items.length > 0 ? (
                      <div className="overflow-x-auto rounded-2xl border border-slate-200/80">
                        <table className="w-full text-xs text-left border-collapse">
                          <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                            <tr>
                              <th className="py-2 px-3 font-medium">Description</th>
                              <th className="py-2 px-3 font-medium w-20 text-right">Quantity</th>
                              <th className="py-2 px-3 font-medium w-28 text-right">Unit Price</th>
                              <th className="py-2 px-3 font-medium w-28 text-right">Amount</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 font-mono text-[12px]">
                            {extraction.line_items.map((item, idx) => (
                              <tr key={idx} className="transition-colors hover:bg-slate-50/80">
                                <td className="py-2 px-3 font-sans text-slate-900">{item.description}</td>
                                <td className="py-2 px-3 text-right text-slate-600">{item.quantity}</td>
                                <td className="py-2 px-3 text-right text-slate-600">
                                  {formatAmount(item.unit_price)}
                                </td>
                                <td className="py-2 px-3 text-right font-semibold text-slate-900">
                                  {formatAmount(item.amount)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="p-6 text-center text-xs text-slate-400 border border-slate-200 rounded-lg">
                        No itemized line items found in document stream.
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* TAB 2: Validation & Rules */}
              {activeTab === 'validation' && (
                <div className="flex flex-col gap-4">
                  {/* Status Banner */}
                  <div
                    className={`flex items-start gap-3 rounded-2xl border p-4 ${
                      validation?.status === 'valid'
                        ? 'border-emerald-200/70 bg-emerald-50 text-emerald-900'
                        : validation?.status === 'invalid'
                        ? 'border-rose-200/70 bg-rose-50 text-rose-900'
                        : 'border-amber-200/70 bg-amber-50 text-amber-900'
                    }`}
                  >
                    {validation?.status === 'valid' ? (
                      <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                    ) : validation?.status === 'invalid' ? (
                      <XCircle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
                    ) : (
                      <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                    )}
                    <div>
                      <div className="font-semibold text-xs uppercase tracking-wide">
                        Validation Verdict: {validation?.status === 'valid' ? 'Fully Validated' : validation?.status === 'invalid' ? 'Confirmed Invalid' : 'Needs Auditor Review'}
                      </div>
                      <p className="text-xs mt-1">
                        {validation?.status === 'valid'
                          ? 'All mandatory fields are present, arithmetic consistency checks passed within rounding tolerance, and no duplicate candidates were detected.'
                          : validation?.status === 'invalid'
                          ? 'Confirmed data or arithmetic contradictions were detected and require correction.'
                          : 'Missing or uncertain evidence requires human verification before approval.'}
                      </p>
                    </div>
                  </div>

                  {/* Financial Balance Reconciliation */}
                  {validation?.reconciliation && (
                    <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs">
                      <h5 className="text-xs font-semibold text-slate-900 mb-2">Financial Balance Reconciliation</h5>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs font-mono">
                        <div>
                          <span className="text-slate-500 block text-[11px]">Stated Subtotal:</span>
                          <span className="text-slate-900 font-semibold">
                            {formatAmount(validation.reconciliation.statedSubtotal)}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-500 block text-[11px]">Stated Tax:</span>
                          <span className="text-slate-900 font-semibold">
                            {formatAmount(validation.reconciliation.statedTax)}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-500 block text-[11px]">Expected Total:</span>
                          <span className="text-slate-900 font-semibold">
                            {formatAmount(validation.reconciliation.expectedTotal)}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-500 block text-[11px]">Stated Total:</span>
                          <span className="text-slate-900 font-semibold">
                            {formatAmount(validation.reconciliation.statedTotal)}
                          </span>
                        </div>
                      </div>
                      {validation.reconciliation.totalDelta !== null && validation.reconciliation.totalDelta !== 0 && (
                        <div className="mt-2 pt-2 border-t border-slate-200 text-xs font-mono text-amber-800">
                          Discrepancy: <span className="font-bold">{formatAmount(validation.reconciliation.totalDelta)}</span> (exceeds rounding tolerance)
                        </div>
                      )}
                    </div>
                  )}

                  {/* Issues List */}
                  <div>
                    <h5 className="text-xs font-semibold text-slate-700 uppercase tracking-wider mb-2">
                      Detected Issues ({validation?.issues.length || 0})
                    </h5>

                    {validation?.issues && validation.issues.length > 0 ? (
                      <div className="space-y-2">
                        {validation.issues.map((issue, idx) => (
                          <div
                            key={idx}
                            className={`flex items-start gap-3 rounded-2xl border p-4 text-xs ${
                              issue.severity === 'error'
                                ? 'border-rose-200/70 bg-rose-50/70 text-rose-900'
                                : 'border-amber-200/70 bg-amber-50/70 text-amber-900'
                            }`}
                          >
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold uppercase shrink-0 mt-0.5 ${
                                issue.severity === 'error' ? 'bg-rose-200 text-rose-800' : 'bg-amber-200 text-amber-800'
                              }`}
                            >
                              {issue.code}
                            </span>
                            <div className="flex-1 min-w-0">
                              <div className="font-semibold flex items-center gap-2">
                                <span>{issue.field ? `Field: ${issue.field}` : 'General Rule'}</span>
                              </div>
                              <p className="mt-0.5 text-slate-700">{issue.message}</p>
                              {issue.evidenceSnippet && (
                                <div className="mt-1 text-[11px] font-mono text-slate-500 bg-white/60 p-1.5 rounded">
                                  Evidence: {issue.evidenceSnippet}
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="p-6 text-center text-xs text-slate-500 border border-slate-200 rounded-lg">
                        No validation issues detected. Document satisfies all criteria.
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* TAB 3: Manual Correction Form */}
              {activeTab === 'correction' && (
                <div className="flex flex-col gap-4">
                  <div className="rounded-2xl border border-slate-200/80 bg-slate-50/70 p-4 text-sm text-slate-600">
                    <p className="font-semibold text-slate-800 mb-0.5">Auditor Field Overrides</p>
                    <p>
                      Manually correct OCR misrecognitions or extraction discrepancies. Every correction is validated, re-reconciled, and logged immutably into the audit trail.
                    </p>
                  </div>

                  {correctionSuccessMsg && (
                    <div className="p-3 bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 rounded flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                      <span>{correctionSuccessMsg}</span>
                    </div>
                  )}

                  {correctionErrorMsg && (
                    <div className="p-3 bg-rose-50 border border-rose-200 text-xs text-rose-800 rounded flex items-center gap-2">
                      <XCircle className="w-4 h-4 text-rose-600 shrink-0" />
                      <span>{correctionErrorMsg}</span>
                    </div>
                  )}

                  <form onSubmit={handleSaveCorrection} className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Field to Correct
                        </label>
                        <select
                          value={selectedField}
                          onChange={(e) => {
                            setSelectedField(e.target.value);
                            setCorrectionValue('');
                          }}
                          className="w-full rounded-xl border border-slate-200/80 bg-white p-3 text-sm text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-4 focus:ring-indigo-100"
                        >
                          <option value="invoice_number">Invoice Number</option>
                          <option value="invoice_date">Invoice Date (YYYY-MM-DD)</option>
                          <option value="supplier_name">Supplier Name</option>
                          <option value="customer_name">Customer Name</option>
                          <option value="subtotal">Subtotal (Numeric)</option>
                          <option value="tax">Tax Amount (Numeric)</option>
                          <option value="total">Total Amount (Numeric)</option>
                          <option value="currency">Currency Code</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Current Value in System
                        </label>
                        <div className="w-full text-xs bg-slate-100 border border-slate-200 rounded-md p-2 font-mono text-slate-700 truncate">
                          {getCurrentFieldValue(selectedField)}
                        </div>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        New Corrected Value
                      </label>
                      <input
                        type="text"
                        placeholder="Enter verified value..."
                        value={correctionValue}
                        onChange={(e) => setCorrectionValue(e.target.value)}
                        className="w-full rounded-xl border border-slate-200/80 bg-white p-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-4 focus:ring-indigo-100"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Correction Reason / Audit Justification <span className="text-rose-500">*</span>
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. OCR misread digit 8 as 0, verified on scan page 1"
                        value={correctionReason}
                        onChange={(e) => setCorrectionReason(e.target.value)}
                        className="w-full rounded-xl border border-slate-200/80 bg-white p-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-4 focus:ring-indigo-100"
                      />
                    </div>

                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="revalidateCheckbox"
                        checked={revalidateOnSave}
                        onChange={(e) => setRevalidateOnSave(e.target.checked)}
                        className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                      />
                      <label htmlFor="revalidateCheckbox" className="text-xs text-slate-700 cursor-pointer">
                        Re-run mathematical reconciliation and validation rules upon saving
                      </label>
                    </div>

                    <div className="pt-2">
                      <button
                        type="submit"
                        disabled={isSavingCorrection || !correctionValue.trim() || !correctionReason.trim()}
                        className="flex cursor-pointer items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 via-blue-600 to-indigo-700 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-indigo-100 transition-all hover:-translate-y-0.5 hover:shadow-lg disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isSavingCorrection ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Save className="w-3.5 h-3.5" />
                        )}
                        <span>{isSavingCorrection ? 'Applying Correction...' : 'Save Manual Correction'}</span>
                      </button>
                    </div>
                  </form>
                </div>
              )}

              {/* TAB 4: Audit Trail */}
              {activeTab === 'audit' && (
                <div className="flex flex-col gap-3">
                  <div className="text-xs text-slate-500 flex items-center justify-between">
                    <span>Immutable log of auditor interventions and value alterations</span>
                    <span className="font-mono">{auditTrail.length} entries</span>
                  </div>

                  {auditTrail.length > 0 ? (
                    <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 overflow-hidden">
                      {auditTrail.map((entry, idx) => (
                        <div key={idx} className="p-3 bg-white text-xs flex flex-col gap-1">
                          <div className="flex items-center justify-between font-mono text-[11px] text-slate-500">
                            <span className="font-semibold text-slate-900">Field: {entry.field}</span>
                            <span>{new Date(entry.updatedAt).toLocaleString()}</span>
                          </div>
                          <div className="flex items-center gap-2 font-mono text-[12px] mt-1">
                            <span className="text-rose-700 bg-rose-50 px-1.5 py-0.5 rounded border border-rose-200">
                              {entry.previousValue !== undefined ? String(entry.previousValue) : 'null'}
                            </span>
                            <span className="text-slate-400">→</span>
                            <span className="text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200 font-semibold">
                              {entry.newValue !== undefined ? String(entry.newValue) : 'null'}
                            </span>
                          </div>
                          {entry.reason && (
                            <div className="text-slate-600 text-[11px] mt-1 bg-slate-50 p-1.5 rounded">
                              Reason: {entry.reason} · Author: <span className="font-medium text-slate-800">{entry.author}</span>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="p-8 text-center text-xs text-slate-400 border border-slate-200 rounded-lg">
                      No manual corrections recorded. All values match raw extracted facts.
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
