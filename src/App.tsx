import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  FileText,
  Upload,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Play,
  RotateCw,
  Eye,
  FileSpreadsheet,
  Image as ImageIcon,
  Table as TableIcon,
  ShieldCheck,
  Activity,
  Layers,
  Database,
  Search,
  Server,
  Code,
  ExternalLink,
  Sparkles,
  ArrowRightLeft,
  KeyRound,
} from 'lucide-react';

import { api, FrontendApiError, getApiAuthToken, setApiAuthToken } from './frontend/api.ts';
import {
  DocumentMetadataResponse,
  DocumentResultResponse,
  HealthResponse,
  JobStatus,
} from './services/api/types.ts';
import { QueueHealthBanner } from './frontend/components/QueueHealthBanner.tsx';
import { UploadDropzone } from './frontend/components/UploadDropzone.tsx';
import { DocumentTable } from './frontend/components/DocumentTable.tsx';
import { DocumentDetailModal } from './frontend/components/DocumentDetailModal.tsx';
import { CrossVerificationView } from './frontend/components/CrossVerificationView.tsx';
import { SemanticSearchView } from './frontend/components/SemanticSearchView.tsx';
import { runDocumentProcessingTests, TestRunResult } from './services/document/tests.ts';
import { runInformationExtractionTests } from './services/extraction/tests.ts';
import { runDataValidationTests } from './services/validation/tests.ts';

type NavigationTab = 'dashboard' | 'semantic' | 'crossverify' | 'upload' | 'verification' | 'specs';

export default function App() {
  const [currentTab, setCurrentTab] = useState<NavigationTab>('dashboard');
  const [apiToken, setApiToken] = useState<string>(() => getApiAuthToken());

  // Documents state
  const [documents, setDocuments] = useState<DocumentMetadataResponse[]>([]);
  const [totalDocuments, setTotalDocuments] = useState<number>(0);
  const [page, setPage] = useState<number>(1);
  const [limit] = useState<number>(10);
  const [totalPages, setTotalPages] = useState<number>(1);
  const [selectedStatus, setSelectedStatus] = useState<JobStatus | undefined>(undefined);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [debouncedSearch, setDebouncedSearch] = useState<string>('');
  const [isLoadingDocs, setIsLoadingDocs] = useState<boolean>(true);

  // Health and Queue stats
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [isLoadingHealth, setIsLoadingHealth] = useState<boolean>(false);

  // Uploading state
  const [isUploading, setIsUploading] = useState<boolean>(false);

  // Inspector Modal state
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [selectedMetadata, setSelectedMetadata] = useState<DocumentMetadataResponse | null>(null);
  const [selectedResult, setSelectedResult] = useState<DocumentResultResponse | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState<boolean>(false);

  // User notification / feedback banner
  const [notification, setNotification] = useState<{
    type: 'success' | 'error' | 'info';
    message: string;
  } | null>(null);

  // Client-side automated tests
  const [suiteResults, setSuiteResults] = useState<{
    isRunning: boolean;
    hasRun: boolean;
    total: number;
    passed: number;
    failed: number;
    categories: Array<{
      category: string;
      tests: TestRunResult[];
    }>;
  }>({
    isRunning: false,
    hasRun: false,
    total: 0,
    passed: 0,
    failed: 0,
    categories: [],
  });

  const notifyTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const showNotification = useCallback((type: 'success' | 'error' | 'info', message: string) => {
    if (notifyTimeoutRef.current) clearTimeout(notifyTimeoutRef.current);
    setNotification({ type, message });
    notifyTimeoutRef.current = setTimeout(() => {
      setNotification(null);
    }, 5000);
  }, []);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setPage(1); // Reset to page 1 on new search
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Fetch Health
  const loadHealth = useCallback(async () => {
    try {
      setIsLoadingHealth(true);
      const data = await api.getHealth();
      setHealth(data);
    } catch (_err) {
      // Backend might be booting
    } finally {
      setIsLoadingHealth(false);
    }
  }, []);

  // Fetch Documents
  const loadDocuments = useCallback(async (isSilent = false) => {
    if (!isSilent) setIsLoadingDocs(true);
    try {
      const resp = await api.listDocuments({
        page,
        limit,
        status: selectedStatus,
        search: debouncedSearch,
      });
      setDocuments(resp.items);
      setTotalDocuments(resp.total);
      setTotalPages(resp.totalPages);
    } catch (err: any) {
      if (!isSilent) {
        showNotification('error', `Failed to load documents: ${err.message}`);
      }
    } finally {
      if (!isSilent) setIsLoadingDocs(false);
    }
  }, [page, limit, selectedStatus, debouncedSearch, showNotification]);

  // Initial load
  useEffect(() => {
    loadHealth();
    loadDocuments();
  }, [loadHealth, loadDocuments]);

  // Auto-polling when documents are queued or processing
  useEffect(() => {
    const hasActiveJobs =
      (health?.queueStatus.queued ?? 0) > 0 ||
      (health?.queueStatus.processing ?? 0) > 0 ||
      documents.some(d => d.status === 'queued' || d.status === 'processing');

    const intervalTime = hasActiveJobs ? 2000 : 7000;

    const interval = setInterval(() => {
      loadHealth();
      loadDocuments(true);

      // If detail modal is open and in a non-terminal status, refresh result too
      if (selectedDocId) {
        const current = documents.find(d => d.id === selectedDocId);
        if (current && (current.status === 'queued' || current.status === 'processing')) {
          api.getDocumentResult(selectedDocId)
            .then(res => setSelectedResult(res))
            .catch(() => {});
        }
      }
    }, intervalTime);

    return () => clearInterval(interval);
  }, [health, documents, selectedDocId, loadHealth, loadDocuments]);

  // Handle Document Selection
  const handleSelectDocument = async (docId: string) => {
    setSelectedDocId(docId);
    const meta = documents.find(d => d.id === docId) || null;
    setSelectedMetadata(meta);
    setIsLoadingDetail(true);

    try {
      const res = await api.getDocumentResult(docId);
      setSelectedResult(res);
    } catch (err: any) {
      showNotification('error', `Could not load document result: ${err.message}`);
    } finally {
      setIsLoadingDetail(false);
    }
  };

  // Handle Multi-file Upload
  const handleUploadFiles = async (
    files: File[]
  ) => {
    setIsUploading(true);
    try {
      const resp = await api.uploadDocuments(files);
      showNotification(
        'success',
        `Enqueued ${resp.totalQueued} document(s) for background processing.`
      );
      // Refresh documents and health
      await loadHealth();
      await loadDocuments();
      setCurrentTab('dashboard');
    } catch (err: any) {
      showNotification('error', err.message || 'File upload failed.');
      throw err;
    } finally {
      setIsUploading(false);
    }
  };

  // Handle Retry Job
  const handleRetryDocument = async (docId: string) => {
    try {
      const resp = await api.retryDocument(docId);
      showNotification('info', `Job for "${docId}" re-enqueued: ${resp.message}`);
      await loadHealth();
      await loadDocuments(true);

      // Refresh detail modal if open
      if (selectedDocId === docId) {
        handleSelectDocument(docId);
      }
    } catch (err: any) {
      showNotification('error', `Failed to retry job: ${err.message}`);
    }
  };

  // Handle Manual Correction
  const handleApplyCorrection = async (
    docId: string,
    corrections: Record<string, any>,
    reason: string,
    revalidate: boolean
  ) => {
    try {
      const resp = await api.applyCorrections(docId, corrections, reason, revalidate);
      showNotification(
        'success',
        `Correction saved for field(s): ${resp.updatedFields.join(', ')}. New status: ${resp.status.toUpperCase()}`
      );
      // Refresh result and documents
      const freshResult = await api.getDocumentResult(docId);
      setSelectedResult(freshResult);
      await loadDocuments(true);
      await loadHealth();
    } catch (err: any) {
      showNotification('error', `Correction rejected: ${err.message}`);
      throw err;
    }
  };

  // Client-side execution of automated verification suites
  const executeVerificationSuites = async () => {
    setSuiteResults(prev => ({ ...prev, isRunning: true }));

    const categories: Array<{ category: string; tests: TestRunResult[] }> = [];

    // Module 1: Document Processing (13 tests)
    const task1 = await runDocumentProcessingTests();
    categories.push({ category: 'Module 1: Multi-Format Document Processing', tests: task1.results });

    // Module 2: AI Information Extraction (8 tests)
    const task2 = await runInformationExtractionTests();
    categories.push({ category: 'Module 2: AI Information Extraction', tests: task2.results });

    // Module 3: Data Validation & Cross-Verification (11 tests)
    const task3 = await runDataValidationTests();
    categories.push({ category: 'Module 3: Data Validation & Cross-Verification', tests: task3.results });

    const total = task1.total + task2.total + task3.total;
    const passed = task1.passed + task2.passed + task3.passed;
    const failed = task1.failed + task2.failed + task3.failed;

    setSuiteResults({
      isRunning: false,
      hasRun: true,
      total,
      passed,
      failed,
      categories,
    });
  };

  return (
    <div className="min-h-screen bg-linear-to-br from-slate-50/70 via-slate-50 to-indigo-50/30 text-slate-900 flex flex-col font-sans">
      {/* Top Bar Navigation */}
      <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-slate-200/80 bg-white/90 px-4 py-3 shadow-xs backdrop-blur-xl sm:px-6 lg:flex-nowrap lg:px-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 via-blue-600 to-indigo-700 text-xs font-bold text-white shadow-md shadow-indigo-200">
            DP
          </div>
          <div>
            <div className="text-base font-bold tracking-tight text-slate-950">
              DocuPulse
            </div>
            <div className="hidden text-[11px] text-slate-500 sm:block">
              AI-Powered Document Intelligence System
            </div>
          </div>
        </div>

        {/* Navigation Tabs */}
        <nav className="order-3 -mx-1 flex w-full items-center gap-1 overflow-x-auto px-1 pb-0.5 text-xs font-medium text-slate-600 lg:order-none lg:mx-0 lg:w-auto lg:justify-center">
          <button
            onClick={() => setCurrentTab('dashboard')}
            className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl px-3 py-2 transition-all ${
              currentTab === 'dashboard'
                ? 'bg-indigo-50 text-indigo-700 font-semibold shadow-inner ring-1 ring-indigo-100'
                : 'hover:bg-slate-100/80 hover:text-slate-900'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>Documents & Queue</span>
          </button>

          <button
            onClick={() => setCurrentTab('semantic')}
            className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl px-3 py-2 transition-all ${
              currentTab === 'semantic'
                ? 'bg-indigo-50 text-indigo-700 font-semibold shadow-inner ring-1 ring-indigo-100'
                : 'hover:bg-slate-100/80 hover:text-slate-900'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5 text-indigo-600" />
            <span>Semantic Search</span>
          </button>

          <button
            onClick={() => setCurrentTab('crossverify')}
            className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl px-3 py-2 transition-all ${
              currentTab === 'crossverify'
                ? 'bg-indigo-50 text-indigo-700 font-semibold shadow-inner ring-1 ring-indigo-100'
                : 'hover:bg-slate-100/80 hover:text-slate-900'
            }`}
          >
            <ArrowRightLeft className="w-3.5 h-3.5 text-sky-600" />
            <span>Cross-Verification</span>
          </button>

          <button
            onClick={() => setCurrentTab('upload')}
            className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl px-3 py-2 transition-all ${
              currentTab === 'upload'
                ? 'bg-indigo-50 text-indigo-700 font-semibold shadow-inner ring-1 ring-indigo-100'
                : 'hover:bg-slate-100/80 hover:text-slate-900'
            }`}
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Ingest & Samples</span>
          </button>

          <button
            onClick={() => setCurrentTab('verification')}
            className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl px-3 py-2 transition-all ${
              currentTab === 'verification'
                ? 'bg-indigo-50 text-indigo-700 font-semibold shadow-inner ring-1 ring-indigo-100'
                : 'hover:bg-slate-100/80 hover:text-slate-900'
            }`}
          >
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>Automated Tests</span>
          </button>

          <button
            onClick={() => setCurrentTab('specs')}
            className={`hidden shrink-0 cursor-pointer items-center gap-1.5 rounded-xl px-3 py-2 transition-all md:flex ${
              currentTab === 'specs'
                ? 'bg-indigo-50 text-indigo-700 font-semibold shadow-inner ring-1 ring-indigo-100'
                : 'hover:bg-slate-100/80 hover:text-slate-900'
            }`}
          >
            <Code className="w-3.5 h-3.5" />
            <span>Architecture & API</span>
          </button>
        </nav>

        {/* Right CTA */}
        <div className="ml-auto flex items-center gap-2">
          <details className="relative">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50">
              <KeyRound className="h-3.5 w-3.5" />
              API token
            </summary>
            <div className="absolute right-0 top-full z-40 mt-2 w-72 rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
              <label htmlFor="api-auth-token" className="text-xs font-semibold text-slate-700">
                Bearer token
              </label>
              <input
                id="api-auth-token"
                type="password"
                autoComplete="off"
                value={apiToken}
                onChange={event => {
                  setApiToken(event.target.value);
                  setApiAuthToken(event.target.value);
                }}
                placeholder="Enter configured API token"
                className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-xs outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
              <p className="mt-2 text-[10px] leading-4 text-slate-500">
                Stored in this browser session only. Requests use the Authorization: Bearer header.
              </p>
            </div>
          </details>
          <button
            onClick={() => setCurrentTab('upload')}
            className="flex items-center gap-2 whitespace-nowrap rounded-xl bg-gradient-to-r from-indigo-600 via-blue-600 to-indigo-700 px-4 py-2.5 text-xs font-semibold text-white shadow-md shadow-indigo-200 transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-indigo-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Upload</span>
          </button>
        </div>
      </header>

      {/* User Notification Toast */}
      {notification && (
        <div className="max-w-7xl w-full mx-auto px-6 pt-3">
          <div
            className={`p-3 rounded-lg border text-xs flex items-center justify-between gap-3 shadow-xs ${
              notification.type === 'success'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : notification.type === 'error'
                ? 'bg-rose-50 border-rose-200 text-rose-900'
                : 'bg-indigo-50 border-indigo-200 text-indigo-900'
            }`}
          >
            <div className="flex items-center gap-2">
              {notification.type === 'success' && <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />}
              {notification.type === 'error' && <XCircle className="w-4 h-4 text-rose-600 shrink-0" />}
              {notification.type === 'info' && <Activity className="w-4 h-4 text-indigo-600 shrink-0" />}
              <span className="font-medium">{notification.message}</span>
            </div>
            <button
              onClick={() => setNotification(null)}
              className="text-xs opacity-60 hover:opacity-100 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Main Container */}
      <main className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col gap-5 px-4 py-5 sm:gap-6 sm:px-6 sm:py-7 lg:px-8">
        {/* Health & Queue Metrics Bar */}
        <QueueHealthBanner
          health={health}
          isLoading={isLoadingHealth}
          onRefresh={() => {
            loadHealth();
            loadDocuments(true);
          }}
        />

        {/* TAB 1: Dashboard (Documents Table & Search) */}
        {currentTab === 'dashboard' && (
          <div className="flex flex-col gap-5">
            <div className="flex flex-col justify-between gap-4 pb-1 sm:flex-row sm:items-end">
              <div>
                <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-indigo-100 bg-indigo-50/80 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-indigo-700">
                  <Activity className="h-3 w-3" />
                  Live document intelligence
                </div>
                <h2 className="text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
                  Ingestion Queue & Processed Documents
                </h2>
                <p className="mt-1.5 max-w-2xl text-sm leading-6 text-slate-500">
                  Real-time pipeline results backed by SQLite WAL storage, background job concurrency, and semantic keyword search.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setCurrentTab('upload')}
                  className="flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200/80 bg-white px-4 py-2.5 text-xs font-semibold text-slate-700 shadow-xs transition-all hover:-translate-y-0.5 hover:border-indigo-200 hover:text-indigo-700 hover:shadow-md"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>Ingest More Documents</span>
                </button>
              </div>
            </div>

            <DocumentTable
              documents={documents}
              total={totalDocuments}
              page={page}
              limit={limit}
              totalPages={totalPages}
              selectedStatus={selectedStatus}
              searchQuery={searchQuery}
              isLoading={isLoadingDocs}
              onPageChange={(p) => setPage(p)}
              onStatusChange={(s) => {
                setSelectedStatus(s);
                setPage(1);
              }}
              onSearchChange={(q) => setSearchQuery(q)}
              onSelectDocument={handleSelectDocument}
              onRetryDocument={handleRetryDocument}
            />
          </div>
        )}

        {/* TAB 2: Dense Vector Semantic Search */}
        {currentTab === 'semantic' && (
          <SemanticSearchView
            onSelectDocument={handleSelectDocument}
            showNotification={showNotification}
          />
        )}

        {/* TAB 3: Cross-Verification (PDF vs Excel / PO Reconciliation) */}
        {currentTab === 'crossverify' && (
          <CrossVerificationView
            documents={documents}
            onSelectDocument={handleSelectDocument}
            showNotification={showNotification}
          />
        )}

        {/* TAB 4: Upload Dropzone & Sample Fixtures */}
        {currentTab === 'upload' && (
          <div className="flex flex-col gap-5">
            <div className="pb-1">
              <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-indigo-100 bg-indigo-50/80 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-indigo-700">
                <Sparkles className="h-3 w-3" />
                Secure, intelligent ingestion
              </div>
              <h2 className="text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
                Multi-Format Document Ingestion
              </h2>
              <p className="mt-1.5 max-w-2xl text-sm leading-6 text-slate-500">
                Upload your business invoices or load pre-built synthetic test fixtures through the live REST API.
              </p>
            </div>

            <UploadDropzone
              isUploading={isUploading}
              onUpload={handleUploadFiles}
            />
          </div>
        )}

        {/* TAB 3: Automated Verification Suite */}
        {currentTab === 'verification' && (
          <div className="bg-white border border-slate-200 rounded-lg p-6 flex flex-col gap-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200">
              <div>
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <ShieldCheck className="w-5 h-5 text-emerald-600" />
                  <span>Automated Verification Suite</span>
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  Executes unit, contract, and hermetic integration checks across Module 1 (Parsing), Module 2 (AI Extraction), and Module 3 (Financial Validation).
                </p>
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={executeVerificationSuites}
                  disabled={suiteResults.isRunning}
                  className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-md transition-colors disabled:opacity-50 flex items-center gap-2 cursor-pointer shadow-xs"
                >
                  <RotateCw className={`w-3.5 h-3.5 ${suiteResults.isRunning ? 'animate-spin' : ''}`} />
                  <span>{suiteResults.isRunning ? 'Executing Test Runner...' : 'Execute Automated Tests'}</span>
                </button>
              </div>
            </div>

            {suiteResults.hasRun ? (
              <div className="flex flex-col gap-6">
                {/* Summary Strip */}
                <div className="flex flex-wrap items-center gap-6 p-4 rounded-lg bg-slate-50 border border-slate-200 text-xs font-mono">
                  <div>
                    <span className="text-slate-500">Total Executed:</span>{' '}
                    <strong className="text-slate-900">{suiteResults.total}</strong>
                  </div>
                  <div>
                    <span className="text-emerald-700">Passed:</span>{' '}
                    <strong className="text-emerald-700">{suiteResults.passed}</strong>
                  </div>
                  <div>
                    <span className={suiteResults.failed > 0 ? 'text-rose-700 font-bold' : 'text-slate-500'}>
                      Failed:
                    </span>{' '}
                    <strong className={suiteResults.failed > 0 ? 'text-rose-700 font-bold' : 'text-slate-700'}>
                      {suiteResults.failed}
                    </strong>
                  </div>
                  <div>
                    <span className="text-slate-500">Success Rate:</span>{' '}
                    <strong className="text-emerald-700">
                      {Math.round((suiteResults.passed / (suiteResults.total || 1)) * 100)}%
                    </strong>
                  </div>
                  <div className="ml-auto font-sans font-semibold text-xs">
                    {suiteResults.failed === 0 ? (
                      <span className="text-emerald-700 flex items-center gap-1">
                        <CheckCircle2 className="w-4 h-4" /> ALL VERIFICATION TESTS PASSING
                      </span>
                    ) : (
                      <span className="text-rose-700 flex items-center gap-1">
                        <XCircle className="w-4 h-4" /> REGRESSIONS DETECTED
                      </span>
                    )}
                  </div>
                </div>

                {/* Categorized Test Blocks */}
                {suiteResults.categories.map((cat, cIdx) => (
                  <div key={cIdx} className="border border-slate-200 rounded-lg overflow-hidden">
                    <div className="px-4 py-2.5 bg-slate-100/70 border-b border-slate-200 font-semibold text-xs text-slate-800">
                      {cat.category} ({cat.tests.length} tests)
                    </div>
                    <div className="divide-y divide-slate-100 font-mono text-xs">
                      {cat.tests.map((t, tIdx) => (
                        <div
                          key={tIdx}
                          className={`p-3 flex items-start justify-between gap-3 ${
                            t.passed ? 'bg-white' : 'bg-rose-50/50'
                          }`}
                        >
                          <div className="flex items-start gap-2.5">
                            {t.passed ? (
                              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                            ) : (
                              <XCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                            )}
                            <div>
                              <div className="font-medium text-slate-900">{t.name}</div>
                              <div className="text-[11px] text-slate-500 mt-0.5">{t.details}</div>
                            </div>
                          </div>
                          <span className="text-[11px] text-slate-400 shrink-0">{t.durationMs}ms</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-12 text-center text-xs text-slate-500 border border-dashed border-slate-200 rounded-lg">
                <Play className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                <div className="font-semibold text-slate-700">Test Runner Idle</div>
                <p className="mt-1 max-w-md mx-auto text-slate-400">
                  Click &quot;Execute Automated Tests&quot; above to run the verification suite directly in the browser, or run{' '}
                  <code className="bg-slate-100 px-1.5 py-0.5 rounded font-mono text-slate-700">npm run test</code>{' '}
                  in the terminal to execute all 51 hermetic tests across all 5 modules.
                </p>
              </div>
            )}
          </div>
        )}

        {/* TAB 4: Architecture & REST API Documentation */}
        {currentTab === 'specs' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-white border border-slate-200 rounded-lg p-5">
              <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider mb-3 flex items-center gap-2">
                <Server className="w-4 h-4 text-indigo-600" />
                <span>REST API Specification</span>
              </h3>
              <p className="text-xs text-slate-600 mb-4">
                FastAPI and Express synchronized endpoints for document upload, job queue polling, structured extraction, audit logging, and retries.
              </p>
              <div className="space-y-2 text-xs font-mono">
                <div className="p-2.5 bg-slate-50 rounded border border-slate-200">
                  <span className="font-bold text-emerald-700">POST</span> /api/v1/documents
                  <p className="text-[11px] font-sans text-slate-500 mt-0.5">Ingests multi-format documents, creates jobs, enqueues to worker queue.</p>
                </div>
                <div className="p-2.5 bg-slate-50 rounded border border-slate-200">
                  <span className="font-bold text-sky-700">GET</span> /api/v1/documents/:id
                  <p className="text-[11px] font-sans text-slate-500 mt-0.5">Returns metadata, retry counts, latency, and queue status.</p>
                </div>
                <div className="p-2.5 bg-slate-50 rounded border border-slate-200">
                  <span className="font-bold text-sky-700">GET</span> /api/v1/documents/:id/result
                  <p className="text-[11px] font-sans text-slate-500 mt-0.5">Returns extracted invoice schema, validation rules, and audit trail.</p>
                </div>
                <div className="p-2.5 bg-slate-50 rounded border border-slate-200">
                  <span className="font-bold text-amber-700">PATCH</span> /api/v1/documents/:id/corrections
                  <p className="text-[11px] font-sans text-slate-500 mt-0.5">Applies auditor corrections, recalculates math, and saves audit trail.</p>
                </div>
                <div className="p-2.5 bg-slate-50 rounded border border-slate-200">
                  <span className="font-bold text-purple-700">POST</span> /api/v1/documents/:id/retry
                  <p className="text-[11px] font-sans text-slate-500 mt-0.5">Safely re-enqueues failed or flagged jobs with concurrency protection.</p>
                </div>
              </div>
              <div className="mt-4 pt-3 border-t border-slate-200 flex items-center justify-between text-xs">
                <span className="text-slate-500">OpenAPI 3.0.3 Contract:</span>
                <a
                  href="/api/v1/openapi.json"
                  target="_blank"
                  rel="noreferrer"
                  className="text-indigo-600 hover:text-indigo-800 font-medium flex items-center gap-1"
                >
                  <span>/api/v1/openapi.json</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-lg p-5">
              <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider mb-3 flex items-center gap-2">
                <Database className="w-4 h-4 text-emerald-600" />
                <span>Persistence & Search Architecture</span>
              </h3>
              <p className="text-xs text-slate-600 mb-4">
                SQLite WAL local database with repeatable schema migrations, indexed query filters, and transparent semantic search fallback.
              </p>
              <div className="space-y-3 text-xs">
                <div className="p-3 bg-slate-50 rounded border border-slate-200">
                  <div className="font-semibold text-slate-800">Database Schema & WAL Mode</div>
                  <p className="text-slate-500 text-[11px] mt-0.5">
                    Tables: <code className="font-mono">documents</code>, <code className="font-mono">document_content</code>, <code className="font-mono">extracted_invoices</code>, <code className="font-mono">validation_issues</code>, <code className="font-mono">audit_trail</code>, <code className="font-mono">processing_history</code>.
                  </p>
                </div>

                <div className="p-3 bg-slate-50 rounded border border-slate-200">
                  <div className="font-semibold text-slate-800">Decimal-Safe Financial Math</div>
                  <p className="text-slate-500 text-[11px] mt-0.5">
                    Amounts are multiplied by 100 and reconciled as integer cents to eliminate IEEE 754 floating point imprecision.
                  </p>
                </div>

                <div className="p-3 bg-slate-50 rounded border border-slate-200">
                  <div className="font-semibold text-slate-800">Security & Isolation</div>
                  <p className="text-slate-500 text-[11px] mt-0.5">
                    File names sanitized against directory traversal attacks (<code className="font-mono">../../</code>). Non-leaking error responses without stack traces.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Inspector / Detail Modal */}
      {selectedDocId && (
        <DocumentDetailModal
          metadata={selectedMetadata}
          result={selectedResult}
          isLoading={isLoadingDetail}
          onClose={() => {
            setSelectedDocId(null);
            setSelectedMetadata(null);
            setSelectedResult(null);
          }}
          onRetry={handleRetryDocument}
          onApplyCorrection={handleApplyCorrection}
        />
      )}
    </div>
  );
}
