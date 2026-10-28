import React, { useState } from 'react';
import {
  DocumentMetadataResponse,
} from '../../services/api/types.ts';
import { api } from '../api.ts';
import {
  FileSpreadsheet,
  FileText,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ArrowRightLeft,
  Loader2,
  Percent,
  Search,
} from 'lucide-react';

interface CrossVerificationViewProps {
  documents: DocumentMetadataResponse[];
  onSelectDocument: (id: string) => void;
  showNotification: (type: 'success' | 'error' | 'info', message: string) => void;
}

export const CrossVerificationView: React.FC<CrossVerificationViewProps> = ({
  documents,
  onSelectDocument,
  showNotification,
}) => {
  const [sourceId, setSourceId] = useState<string>('');
  const [targetId, setTargetId] = useState<string>('');
  const [isVerifying, setIsVerifying] = useState<boolean>(false);
  const [result, setResult] = useState<any | null>(null);

  // Filter documents that have completed extraction
  const completedDocs = documents.filter(d => d.status === 'completed' || d.status === 'needs_review' || d.status === 'invalid');

  const handleRunCrossVerification = async () => {
    if (!sourceId || !targetId) {
      showNotification('error', 'Please select both a Source and Target document to cross-verify.');
      return;
    }
    if (sourceId === targetId) {
      showNotification('error', 'Please select two distinct documents for cross-verification.');
      return;
    }

    setIsVerifying(true);
    setResult(null);

    try {
      const data = await api.crossVerify(sourceId, targetId);
      setResult(data);
      showNotification('success', `Cross-verification completed. Match score: ${data.matchScorePercent}%`);
    } catch (err: any) {
      showNotification('error', `Cross-verification failed: ${err.message}`);
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Header Introduction */}
      <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-6">
        <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
          <ArrowRightLeft className="w-5 h-5 text-indigo-600" />
          Cross-Document Verification & Reconciliation
        </h2>
        <p className="text-xs text-slate-500 mt-1 max-w-3xl">
          Reconciles invoice and purchase order documents across formats (e.g., <strong>PDF Invoice vs Excel PO</strong>,
          <strong>PDF vs PDF Delivery Note</strong>, or <strong>CSV vs XLSX</strong>). Automatically matches line items,
          detects quantity variances, unit price deltas, and validates total ledger reconciliation.
        </p>

        {/* Document Selection Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-5 pt-4 border-t border-slate-100">
          {/* Source Document */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-indigo-500"></span>
              Document A (e.g. PDF Invoice)
            </label>
            <select
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              className="w-full rounded-xl border border-slate-200/80 bg-slate-50/70 p-3 text-sm text-slate-800 focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-4 focus:ring-indigo-100"
            >
              <option value="">-- Select Source Document --</option>
              {completedDocs.map((doc) => (
                <option key={doc.id} value={doc.id}>
                  [{doc.fileType.toUpperCase()}] {doc.originalFilename} ({doc.id})
                </option>
              ))}
            </select>
          </div>

          {/* Target Document */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
              Document B (e.g. Excel PO / Delivery Log)
            </label>
            <select
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              className="w-full rounded-xl border border-slate-200/80 bg-slate-50/70 p-3 text-sm text-slate-800 focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-4 focus:ring-indigo-100"
            >
              <option value="">-- Select Target Document --</option>
              {completedDocs.map((doc) => (
                <option key={doc.id} value={doc.id}>
                  [{doc.fileType.toUpperCase()}] {doc.originalFilename} ({doc.id})
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-end">
          <button
            onClick={handleRunCrossVerification}
            disabled={!sourceId || !targetId || isVerifying}
            className="flex cursor-pointer items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 via-blue-600 to-indigo-700 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-indigo-100 transition-all hover:-translate-y-0.5 hover:shadow-lg disabled:cursor-not-allowed disabled:from-slate-300 disabled:via-slate-300 disabled:to-slate-300"
          >
            {isVerifying ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Cross-Reconciling Documents...
              </>
            ) : (
              <>
                <ArrowRightLeft className="w-4 h-4" />
                Execute Cross-Verification
              </>
            )}
          </button>
        </div>
      </div>

      {/* Cross-Verification Results Section */}
      {result && (
        <div className="flex flex-col gap-6 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-6">
          {/* Top Score Banner */}
          <div className="flex flex-col justify-between gap-4 rounded-2xl border border-slate-200/80 bg-gradient-to-r from-slate-50 to-indigo-50/40 p-4 sm:flex-row sm:items-center sm:p-5">
            <div>
              <div className="text-xs text-slate-500 uppercase tracking-wider font-semibold">
                Reconciliation Status
              </div>
              <div className="text-lg font-bold text-slate-900 capitalize mt-0.5">
                {result.reconciliationStatus.replace(/_/g, ' ')}
              </div>
              <div className="text-xs text-slate-500 mt-1">
                Verified at: {new Date(result.verifiedAt).toLocaleTimeString()} | Total Discrepancies: {result.discrepancies.length}
              </div>
            </div>

            <div className="flex items-center gap-3 rounded-2xl border border-slate-200/80 bg-white px-4 py-3 shadow-sm">
              <div className="flex flex-col items-center">
                <span className="text-[10px] text-slate-400 font-semibold uppercase">Match Score</span>
                <span className={`text-2xl font-black ${
                  result.matchScorePercent >= 80 ? 'text-emerald-600' :
                  result.matchScorePercent >= 50 ? 'text-amber-600' : 'text-rose-600'
                }`}>
                  {result.matchScorePercent}%
                </span>
              </div>
              <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-slate-700">
                <Percent className="w-4 h-4" />
              </div>
            </div>
          </div>

          {/* Header & Financial Comparison Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Header Integrity */}
            <div className="rounded-2xl border border-slate-200/80 p-4">
              <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-3">
                Header Integrity Check
              </h3>
              <div className="divide-y divide-slate-100 text-xs">
                <div className="py-1.5 flex items-center justify-between">
                  <span className="text-slate-500">Invoice / PO Reference</span>
                  <span className={`font-semibold ${result.headerReconciliation.invoiceNumberMatch ? 'text-emerald-700' : 'text-amber-700'}`}>
                    {result.headerReconciliation.invoiceNumberMatch ? '✓ Matched' : '⚠ Discrepancy'}
                  </span>
                </div>
                <div className="py-1.5 flex items-center justify-between">
                  <span className="text-slate-500">Supplier Name</span>
                  <span className={`font-semibold ${result.headerReconciliation.supplierMatch ? 'text-emerald-700' : 'text-rose-700'}`}>
                    {result.headerReconciliation.supplierMatch ? '✓ Matched' : '✗ Mismatch'}
                  </span>
                </div>
                <div className="py-1.5 flex items-center justify-between">
                  <span className="text-slate-500">Customer Name</span>
                  <span className={`font-semibold ${result.headerReconciliation.customerMatch ? 'text-emerald-700' : 'text-slate-600'}`}>
                    {result.headerReconciliation.customerMatch ? '✓ Matched' : 'N/A or Divergent'}
                  </span>
                </div>
                <div className="py-1.5 flex items-center justify-between">
                  <span className="text-slate-500">Currency</span>
                  <span className={`font-semibold ${result.headerReconciliation.currencyMatch ? 'text-emerald-700' : 'text-rose-700'}`}>
                    {result.headerReconciliation.currencyMatch ? '✓ Matched' : '✗ Currency Mismatch'}
                  </span>
                </div>
              </div>
            </div>

            {/* Financial Amounts Reconciliation */}
            <div className="rounded-2xl border border-slate-200/80 p-4">
              <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-3">
                Financial Amounts Reconciliation
              </h3>
              <div className="divide-y divide-slate-100 text-xs">
                <div className="py-1.5 flex items-center justify-between">
                  <span className="text-slate-500">Doc A Total</span>
                  <span className="font-semibold text-slate-800">${result.financialReconciliation.sourceTotal?.toFixed(2) ?? 'N/A'}</span>
                </div>
                <div className="py-1.5 flex items-center justify-between">
                  <span className="text-slate-500">Doc B Total</span>
                  <span className="font-semibold text-slate-800">${result.financialReconciliation.targetTotal?.toFixed(2) ?? 'N/A'}</span>
                </div>
                <div className="py-1.5 flex items-center justify-between">
                  <span className="text-slate-500">Total Delta</span>
                  <span className={`font-bold ${result.financialReconciliation.totalMatched ? 'text-emerald-700' : 'text-rose-700'}`}>
                    ${result.financialReconciliation.totalDelta?.toFixed(2) ?? '0.00'} {result.financialReconciliation.totalMatched ? '(Within tolerance)' : '(MISMATCH)'}
                  </span>
                </div>
                <div className="py-1.5 flex items-center justify-between">
                  <span className="text-slate-500">Subtotal Delta</span>
                  <span className="text-slate-700">${result.financialReconciliation.subtotalDelta?.toFixed(2) ?? '0.00'}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Line Items Reconciliation Table */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                Line Items Reconciliation ({result.lineItemsReconciliation.matchedCount} Matched, {result.lineItemsReconciliation.varianceCount} Variance, {result.lineItemsReconciliation.unmatchedCount} Unmatched)
              </h3>
            </div>

            <div className="overflow-x-auto rounded-2xl border border-slate-200/80">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-600 font-semibold">
                    <th className="py-2 px-3">Status</th>
                    <th className="py-2 px-3">Item Description</th>
                    <th className="py-2 px-3">Doc A (Qty @ Price)</th>
                    <th className="py-2 px-3">Doc B (Qty @ Price)</th>
                    <th className="py-2 px-3">Doc A Sum</th>
                    <th className="py-2 px-3">Doc B Sum</th>
                    <th className="py-2 px-3 text-right">Variance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {result.lineItemsReconciliation.matches.map((m: any, idx: number) => (
                    <tr key={idx} className="hover:bg-slate-50/50">
                      <td className="py-2 px-3">
                        {m.status === 'matched' ? (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-800">
                            Matched
                          </span>
                        ) : m.status === 'quantity_variance' ? (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-800">
                            Qty Variance
                          </span>
                        ) : m.status === 'price_variance' ? (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-800">
                            Price Variance
                          </span>
                        ) : (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-rose-100 text-rose-800">
                            Missing in Target
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-3 font-medium text-slate-800">
                        {m.sourceItem?.description || m.targetItem?.description || `Item #${idx + 1}`}
                      </td>
                      <td className="py-2 px-3 text-slate-600">
                        {m.sourceItem ? `${m.sourceItem.quantity ?? '-'} @ $${m.sourceItem.unit_price ?? '-'}` : '—'}
                      </td>
                      <td className="py-2 px-3 text-slate-600">
                        {m.targetItem ? `${m.targetItem.quantity ?? '-'} @ $${m.targetItem.unit_price ?? '-'}` : '—'}
                      </td>
                      <td className="py-2 px-3 font-medium text-slate-700">
                        ${m.sourceItem?.amount?.toFixed(2) ?? '—'}
                      </td>
                      <td className="py-2 px-3 font-medium text-slate-700">
                        ${m.targetItem?.amount?.toFixed(2) ?? '—'}
                      </td>
                      <td className="py-2 px-3 text-right font-semibold">
                        {m.amountDelta !== null ? (
                          <span className={m.amountDelta === 0 ? 'text-emerald-700' : 'text-rose-700'}>
                            {m.amountDelta === 0 ? '$0.00' : `Δ $${m.amountDelta.toFixed(2)}`}
                          </span>
                        ) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Discrepancies List */}
          {result.discrepancies.length > 0 && (
            <div className="border border-amber-200 bg-amber-50/50 rounded-lg p-4">
              <h4 className="text-xs font-bold text-amber-900 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4 text-amber-600" />
                Audited Discrepancies ({result.discrepancies.length})
              </h4>
              <ul className="space-y-1.5 text-xs text-amber-900">
                {result.discrepancies.map((d: any, idx: number) => (
                  <li key={idx} className="flex items-start gap-2">
                    <span className="font-mono text-[10px] px-1 bg-amber-100 rounded text-amber-800 shrink-0 mt-0.5">
                      {d.field}
                    </span>
                    <span>{d.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
