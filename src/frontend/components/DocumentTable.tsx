import React from 'react';
import {
  DocumentMetadataResponse,
  JobStatus,
} from '../../services/api/types.ts';
import {
  FileText,
  FileSpreadsheet,
  Image as ImageIcon,
  Table as TableIcon,
  FileWarning,
  RotateCw,
  Search,
  ChevronLeft,
  ChevronRight,
  Clock,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Eye,
  Loader2,
} from 'lucide-react';

interface DocumentTableProps {
  documents: DocumentMetadataResponse[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  selectedStatus?: JobStatus;
  searchQuery: string;
  isLoading: boolean;
  onPageChange: (newPage: number) => void;
  onStatusChange: (status?: JobStatus) => void;
  onSearchChange: (query: string) => void;
  onSelectDocument: (docId: string) => void;
  onRetryDocument: (docId: string) => void;
}

export const DocumentTable: React.FC<DocumentTableProps> = ({
  documents,
  total,
  page,
  limit,
  totalPages,
  selectedStatus,
  searchQuery,
  isLoading,
  onPageChange,
  onStatusChange,
  onSearchChange,
  onSelectDocument,
  onRetryDocument,
}) => {
  const getFormatIcon = (type: string) => {
    switch (type.toLowerCase()) {
      case 'pdf':
        return <FileText className="w-4 h-4 text-rose-600" />;
      case 'xlsx':
      case 'xls':
        return <FileSpreadsheet className="w-4 h-4 text-emerald-600" />;
      case 'csv':
        return <TableIcon className="w-4 h-4 text-sky-600" />;
      case 'image':
      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'tiff':
        return <ImageIcon className="w-4 h-4 text-amber-600" />;
      default:
        return <FileWarning className="w-4 h-4 text-slate-400" />;
    }
  };

  const getStatusBadge = (status: JobStatus) => {
    switch (status) {
      case 'queued':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200/80 bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
            <Clock className="w-3 h-3 text-slate-500" />
            Queued
          </span>
        );
      case 'processing':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo-200/70 bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">
            <Loader2 className="w-3 h-3 animate-spin text-indigo-600" />
            Processing
          </span>
        );
      case 'completed':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200/60 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 shadow-2xs">
            <CheckCircle2 className="w-3 h-3 text-emerald-600" />
            Valid
          </span>
        );
      case 'needs_review':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200/60 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
            <AlertTriangle className="w-3 h-3 text-amber-600" />
            Needs Review
          </span>
        );
      case 'invalid':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-200/60 bg-rose-50 px-3 py-1 text-xs font-semibold text-rose-700">
            <XCircle className="w-3 h-3 text-rose-600" />
            Invalid
          </span>
        );
      case 'failed':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-200/60 bg-rose-50 px-3 py-1 text-xs font-semibold text-rose-700">
            <XCircle className="w-3 h-3 text-rose-600" />
            Failed
          </span>
        );
      default:
        return null;
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const formatTimestamp = (isoString: string): string => {
    try {
      const date = new Date(isoString);
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return isoString;
    }
  };

  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm">
      {/* Search and Filters Toolbar */}
      <div className="flex flex-col items-stretch justify-between gap-3 border-b border-slate-200/80 bg-white p-4 sm:flex-row sm:items-center sm:p-5">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search by filename, document ID, supplier, or invoice #..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full rounded-xl border border-slate-200/80 bg-slate-50/70 py-2.5 pl-10 pr-3 text-sm text-slate-900 placeholder:text-slate-400 transition-colors focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-4 focus:ring-indigo-100"
          />
        </div>

        <div className="flex items-center gap-3">
          <label className="whitespace-nowrap text-xs font-medium text-slate-500">Status</label>
          <select
            value={selectedStatus || ''}
            onChange={(e) => onStatusChange(e.target.value ? (e.target.value as JobStatus) : undefined)}
            className="min-w-40 rounded-xl border border-slate-200/80 bg-white px-3 py-2.5 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-4 focus:ring-indigo-100"
          >
            <option value="">All Statuses ({total})</option>
            <option value="completed">Valid</option>
            <option value="needs_review">Needs Review</option>
            <option value="invalid">Invalid</option>
            <option value="processing">Processing</option>
            <option value="queued">Queued</option>
            <option value="failed">Failed</option>
          </select>
        </div>
      </div>

      {/* Table Content */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] border-collapse text-left text-xs">
          <thead>
            <tr className="select-none border-b border-slate-200/80 bg-slate-50/80 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              <th className="w-12 px-4 py-3">Type</th>
              <th className="px-4 py-3">Document Filename</th>
              <th className="px-4 py-3">Document ID</th>
              <th className="px-4 py-3">Size</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Time</th>
              <th className="px-4 py-3">Latency</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100/80">
            {isLoading && documents.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-12 text-center text-slate-500">
                  <Loader2 className="w-6 h-6 animate-spin mx-auto text-slate-400 mb-2" />
                  <span>Loading ingestion queue...</span>
                </td>
              </tr>
            ) : documents.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-12 text-center text-slate-500">
                  <div className="max-w-sm mx-auto">
                    <FileText className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                    <div className="font-semibold text-slate-700">No documents found</div>
                    <div className="text-[11px] text-slate-400 mt-1">
                      {searchQuery || selectedStatus
                        ? 'Try clearing the search or status filter.'
                        : 'Upload files above or load a sample fixture to begin processing.'}
                    </div>
                  </div>
                </td>
              </tr>
            ) : (
              documents.map((doc) => {
                const canRetry = doc.status === 'failed' || doc.status === 'needs_review';
                return (
                  <tr
                    key={doc.id}
                    className="group cursor-pointer transition-colors hover:bg-slate-50/80"
                    onClick={() => onSelectDocument(doc.id)}
                  >
                    <td className="px-4 py-4">
                      {getFormatIcon(doc.fileType)}
                    </td>
                    <td className="max-w-64 px-4 py-4">
                      <div className="font-medium text-slate-900 truncate max-w-xs">
                        {doc.sanitizedFilename}
                      </div>
                      {doc.originalFilename !== doc.sanitizedFilename && (
                        <div className="text-[10px] text-slate-400 font-mono truncate max-w-xs">
                          orig: {doc.originalFilename}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-4 font-mono text-[11px] text-slate-500">
                      {doc.id}
                    </td>
                    <td className="px-4 py-4 font-mono text-[11px] tabular-nums text-slate-600">
                      {formatFileSize(doc.fileSizeBytes)}
                    </td>
                    <td className="px-4 py-4">
                      {getStatusBadge(doc.status)}
                    </td>
                    <td className="px-4 py-4 font-mono text-[11px] text-slate-500">
                      {formatTimestamp(doc.createdAt)}
                    </td>
                    <td className="px-4 py-4 font-mono text-[11px] tabular-nums text-slate-500">
                      {doc.processingDurationMs !== undefined ? `${doc.processingDurationMs}ms` : '—'}
                    </td>
                    <td className="px-4 py-4 text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => onSelectDocument(doc.id)}
                          title="Inspect extracted fields and validation report"
                          className="px-2.5 py-1 text-[11px] font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-100 hover:text-slate-900 transition-colors flex items-center gap-1 cursor-pointer"
                        >
                          <Eye className="w-3 h-3 text-slate-500" />
                          <span>Inspect</span>
                        </button>

                        {canRetry && (
                          <button
                            onClick={() => onRetryDocument(doc.id)}
                            title="Re-run processing pipeline"
                            className="px-2 py-1 text-[11px] font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-700 transition-colors flex items-center gap-1 cursor-pointer"
                          >
                            <RotateCw className="w-3 h-3" />
                            <span>Retry</span>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination Footer */}
      <div className="flex flex-col items-start justify-between gap-3 border-t border-slate-200/80 bg-slate-50/50 p-4 text-xs text-slate-500 sm:flex-row sm:items-center">
        <div>
          Showing <span className="font-medium text-slate-800">{documents.length > 0 ? (page - 1) * limit + 1 : 0}</span> to{' '}
          <span className="font-medium text-slate-800">{Math.min(page * limit, total)}</span> of{' '}
          <span className="font-medium text-slate-800">{total}</span> documents
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            className="p-1.5 rounded border border-slate-200 bg-white hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            <ChevronLeft className="w-4 h-4 text-slate-600" />
          </button>
          <span className="font-mono text-[11px]">
            Page {page} of {totalPages || 1}
          </span>
          <button
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
            className="p-1.5 rounded border border-slate-200 bg-white hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            <ChevronRight className="w-4 h-4 text-slate-600" />
          </button>
        </div>
      </div>
    </div>
  );
};
