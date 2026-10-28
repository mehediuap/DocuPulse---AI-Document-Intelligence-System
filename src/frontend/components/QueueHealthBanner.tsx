import React from 'react';
import { HealthResponse } from '../../services/api/types.ts';
import { Activity, RefreshCw, AlertCircle, CheckCircle2, Clock, XCircle } from 'lucide-react';

interface QueueHealthBannerProps {
  health: HealthResponse | null;
  isLoading: boolean;
  onRefresh: () => void;
}

export const QueueHealthBanner: React.FC<QueueHealthBannerProps> = ({
  health,
  isLoading,
  onRefresh,
}) => {
  const queue = health?.queueStatus || {
    queued: 0,
    processing: 0,
    completed: 0,
    needs_review: 0,
    invalid: 0,
    failed: 0,
    total: 0,
  };

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        {/* Left: System Status & Engine Info */}
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 via-blue-600 to-indigo-700 text-white shadow-md shadow-indigo-100">
            <Activity className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-900 uppercase tracking-wider">
                DocuPulse Engine Status
              </span>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                  health?.status === 'ok'
                    ? 'border-emerald-200/60 bg-emerald-50 text-emerald-700'
                    : 'border-amber-200/60 bg-amber-50 text-amber-700'
                }`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                {health?.status === 'ok' ? 'Online' : 'Degraded'}
              </span>
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              Service: <span className="font-mono text-slate-700">{health?.service || 'docupulse-backend'}</span> · Env: <span className="font-mono text-slate-700">{health?.environment || 'development'}</span> · DB: <span className={`font-mono ${health?.databaseStatus === 'connected' ? 'text-emerald-700' : 'text-rose-700'}`}>{health?.databaseStatus || 'unknown'}</span> · Ext: <span className="font-mono text-indigo-700 font-medium">Mock & Rules (Deterministic)</span>
            </div>
          </div>
        </div>

        {/* Right: Real-Time Queue Metric Counters */}
        <div className="flex flex-wrap items-center gap-2 text-xs font-mono md:justify-end">
          <div className="flex items-center gap-1.5 rounded-xl border border-slate-200/80 bg-slate-50 px-3 py-2">
            <Clock className="w-3.5 h-3.5 text-slate-500" />
            <span className="text-slate-500">Queued:</span>
            <span className="font-bold text-slate-900">{queue.queued}</span>
          </div>

          <div className="flex items-center gap-1.5 rounded-xl border border-indigo-200/70 bg-indigo-50/70 px-3 py-2">
            <RefreshCw className={`w-3.5 h-3.5 text-indigo-600 ${queue.processing > 0 ? 'animate-spin' : ''}`} />
            <span className="text-indigo-700">Processing:</span>
            <span className="font-bold text-indigo-900">{queue.processing}</span>
          </div>

          <div className="flex items-center gap-1.5 rounded-xl border border-emerald-200/70 bg-emerald-50/70 px-3 py-2">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
            <span className="text-emerald-700">Valid:</span>
            <span className="font-bold text-emerald-900">{queue.completed}</span>
          </div>

          <div className="flex items-center gap-1.5 rounded-xl border border-amber-200/70 bg-amber-50/70 px-3 py-2">
            <AlertCircle className="w-3.5 h-3.5 text-amber-600" />
            <span className="text-amber-700">Needs Review:</span>
            <span className="font-bold text-amber-900">{queue.needs_review}</span>
          </div>

          <div className="flex items-center gap-1.5 rounded-xl border border-rose-200/70 bg-rose-50/70 px-3 py-2">
            <XCircle className="w-3.5 h-3.5 text-rose-600" />
            <span className="text-rose-700">Invalid:</span>
            <span className="font-bold text-rose-900">{queue.invalid}</span>
          </div>

          <div className="flex items-center gap-1.5 rounded-xl border border-rose-200/70 bg-rose-50/70 px-3 py-2">
            <XCircle className="w-3.5 h-3.5 text-rose-600" />
            <span className="text-rose-700">Failed:</span>
            <span className="font-bold text-rose-900">{queue.failed}</span>
          </div>

          <button
            onClick={onRefresh}
            disabled={isLoading}
            title="Poll API for latest status"
            className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded border border-slate-200 transition-colors disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-indigo-600' : ''}`} />
          </button>
        </div>
      </div>
    </div>
  );
};
