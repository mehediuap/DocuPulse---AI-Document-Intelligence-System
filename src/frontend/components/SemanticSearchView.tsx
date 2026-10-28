import React, { useState } from 'react';
import { api } from '../api.ts';
import { DocumentMetadataResponse } from '../../services/api/types.ts';
import {
  Search,
  Sparkles,
  Loader2,
  FileText,
  Percent,
  CheckCircle2,
  ExternalLink,
  Layers,
} from 'lucide-react';

interface SemanticSearchViewProps {
  onSelectDocument: (docId: string) => void;
  showNotification: (type: 'success' | 'error' | 'info', message: string) => void;
}

export const SemanticSearchView: React.FC<SemanticSearchViewProps> = ({
  onSelectDocument,
  showNotification,
}) => {
  const [query, setQuery] = useState<string>('');
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [searchResponse, setSearchResponse] = useState<any | null>(null);

  const sampleQueries = [
    'GPU acceleration and computing hardware',
    'Enterprise software subscriptions and cloud hosting',
    'Office food catering and coffee refreshments',
    'Precision industrial sensors and robotics',
  ];

  const handleSearch = async (searchQuery: string) => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    setSearchResponse(null);

    try {
      const data = await api.semanticSearch(searchQuery.trim(), 0.15);
      setSearchResponse(data);
      showNotification('success', `Vector semantic search returned ${data.totalMatches} match(es).`);
    } catch (err: any) {
      showNotification('error', `Semantic search failed: ${err.message}`);
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-6">
      {/* Intro Header */}
      <div>
        <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-indigo-600" />
          Dense Vector Semantic Search
        </h2>
        <p className="text-xs text-slate-500 mt-1 max-w-3xl">
          Queries document content conceptually using dense vector embeddings and cosine similarity.
          Matches invoices even when exact keywords differ (e.g., searching for <em>&ldquo;computing hardware&rdquo;</em> finds <em>&ldquo;NVIDIA Graphics Accelerators&rdquo;</em>).
        </p>
      </div>

      {/* Search Input Bar */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSearch(query);
        }}
        className="flex gap-2"
      >
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Enter conceptual search (e.g., 'cloud infrastructure fees', 'robotics actuators')..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-xl border border-slate-200/80 bg-slate-50/70 py-3 pl-10 pr-3 text-sm text-slate-900 transition-colors focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-4 focus:ring-indigo-100"
          />
        </div>

        <button
          type="submit"
          disabled={!query.trim() || isSearching}
          className="flex cursor-pointer items-center gap-1.5 rounded-xl bg-gradient-to-r from-indigo-600 via-blue-600 to-indigo-700 px-4 py-3 text-sm font-semibold text-white shadow-md shadow-indigo-100 transition-all hover:-translate-y-0.5 hover:shadow-lg disabled:cursor-not-allowed disabled:from-slate-300 disabled:via-slate-300 disabled:to-slate-300"
        >
          {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          <span>Vector Search</span>
        </button>
      </form>

      {/* Query Suggestions */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-slate-400 font-medium">Try concepts:</span>
        {sampleQueries.map((q, idx) => (
          <button
            key={idx}
            type="button"
            onClick={() => {
              setQuery(q);
              handleSearch(q);
            }}
            className="px-2.5 py-1 text-[11px] bg-slate-100 hover:bg-indigo-50 hover:text-indigo-700 rounded-full text-slate-600 transition-colors cursor-pointer border border-slate-200"
          >
            {q}
          </button>
        ))}
      </div>

      {/* Results Section */}
      {searchResponse && (
        <div className="flex flex-col gap-4 pt-4 border-t border-slate-100">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>
              Found <strong>{searchResponse.totalMatches}</strong> match(es) for &ldquo;{searchResponse.query}&rdquo;
            </span>
            <span className="text-[11px] bg-slate-100 px-2 py-0.5 rounded text-slate-600 font-mono">
              Mode: {searchResponse.mode} | Dims: {searchResponse.embeddingDimension}
            </span>
          </div>

          {searchResponse.results.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-400">
              No documents matched with sufficient cosine similarity. Try broader conceptual terms or ingest more invoices.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {searchResponse.results.map((res: any, idx: number) => {
                const doc = res.document;
                const matchPct = Math.round(res.similarityScore * 100);
                return (
                  <div
                    key={idx}
                    className="flex flex-col items-start justify-between gap-4 rounded-2xl border border-slate-200/80 bg-slate-50/50 p-4 transition-all hover:border-indigo-200 hover:bg-white hover:shadow-sm sm:flex-row sm:items-center"
                  >
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-indigo-50 border border-indigo-200 flex items-center justify-center text-indigo-700 shrink-0 mt-0.5">
                        <FileText className="w-4 h-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-xs text-slate-900 truncate">
                            {doc.originalFilename}
                          </span>
                          <span className="text-[10px] font-mono px-1.5 py-0.5 bg-slate-200 rounded text-slate-700">
                            {doc.fileType.toUpperCase()}
                          </span>
                        </div>

                        {doc.extraction && (
                          <div className="text-[11px] text-slate-600 mt-0.5 flex flex-wrap gap-x-3">
                            <span>Supplier: <strong>{doc.extraction.supplier_name || 'N/A'}</strong></span>
                            <span>Invoice #: <strong>{doc.extraction.invoice_number || 'N/A'}</strong></span>
                            <span>Total: <strong>${doc.extraction.total?.toFixed(2) ?? 'N/A'}</strong></span>
                          </div>
                        )}

                        {res.matchedSnippet && (
                          <p className="text-[11px] text-slate-500 italic mt-1 line-clamp-2">
                            &ldquo;{res.matchedSnippet}&rdquo;
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-3 shrink-0 self-end sm:self-center">
                      <div className="flex flex-col items-end">
                        <span className="text-[10px] text-slate-400 font-semibold uppercase">Cosine Score</span>
                        <span className={`text-sm font-black ${
                          matchPct >= 60 ? 'text-emerald-600' :
                          matchPct >= 35 ? 'text-indigo-600' : 'text-slate-600'
                        }`}>
                          {matchPct}%
                        </span>
                      </div>

                      <button
                        onClick={() => onSelectDocument(doc.id)}
                        className="px-3 py-1.5 text-xs bg-slate-900 hover:bg-slate-800 text-white rounded font-medium flex items-center gap-1 cursor-pointer transition-colors"
                      >
                        <span>View</span>
                        <ExternalLink className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
