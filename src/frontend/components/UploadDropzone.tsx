import React, { useState, useRef } from 'react';
import {
  Upload,
  FileUp,
  Sparkles,
  AlertCircle,
  Loader2,
  FileText,
  FileSpreadsheet,
  Image as ImageIcon,
  Table2,
} from 'lucide-react';
import { DEMO_FIXTURES, DemoFixture } from '../sampleFixtures.ts';

interface UploadDropzoneProps {
  isUploading: boolean;
  onUpload: (files: Array<{ name: string; size: number; type: string; data: string }>) => Promise<void>;
}

const ALLOWED_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.tif', '.tiff', '.xlsx', '.xls', '.csv'];
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB
const FORMAT_BADGES = [
  { label: 'PDF', Icon: FileText },
  { label: 'Excel', Icon: FileSpreadsheet },
  { label: 'TIFF', Icon: ImageIcon },
  { label: 'CSV', Icon: Table2 },
  { label: 'PNG / JPG', Icon: ImageIcon },
];

export const UploadDropzone: React.FC<UploadDropzoneProps> = ({
  isUploading,
  onUpload,
}) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [loadingFixtureId, setLoadingFixtureId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const readFileAsDataUrl = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error(`Failed to read file ${file.name}`));
      reader.readAsDataURL(file);
    });
  };

  const processAndUploadFiles = async (fileList: FileList | File[]) => {
    setUploadError(null);
    const filesArray = Array.from(fileList);

    if (filesArray.length === 0) return;

    // Validate size and extensions
    const validPayloads: Array<{ name: string; size: number; type: string; data: string }> = [];

    for (const file of filesArray) {
      if (file.size > MAX_FILE_SIZE_BYTES) {
        setUploadError(`File "${file.name}" exceeds the 25 MB size limit (${(file.size / (1024 * 1024)).toFixed(2)} MB).`);
        return;
      }

      const lowerName = file.name.toLowerCase();
      const hasValidExt = ALLOWED_EXTENSIONS.some(ext => lowerName.endsWith(ext));
      if (!hasValidExt) {
        setUploadError(`File "${file.name}" has an unsupported format. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`);
        return;
      }

      try {
        const dataUrl = await readFileAsDataUrl(file);
        validPayloads.push({
          name: file.name,
          size: file.size,
          type: file.type || 'application/octet-stream',
          data: dataUrl,
        });
      } catch (err: any) {
        setUploadError(`Error reading file "${file.name}": ${err.message}`);
        return;
      }
    }

    try {
      await onUpload(validPayloads);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    } catch (err: any) {
      setUploadError(err.message || 'Upload failed.');
    }
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    if (isUploading) return;
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await processAndUploadFiles(e.dataTransfer.files);
    }
  };

  const handleZoneKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.key === 'Enter' || e.key === ' ') && !isUploading) {
      e.preventDefault();
      fileInputRef.current?.click();
    }
  };

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      await processAndUploadFiles(e.target.files);
    }
  };

  const handleLoadFixture = async (fixture: DemoFixture) => {
    setLoadingFixtureId(fixture.id);
    setUploadError(null);
    try {
      const generated = fixture.generate();
      await onUpload([generated]);
    } catch (err: any) {
      setUploadError(err.message || 'Failed to ingest demo fixture.');
    } finally {
      setLoadingFixtureId(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Upload Zone */}
      <div
        role="button"
        tabIndex={isUploading ? -1 : 0}
        aria-label="Choose invoice files or drop them here"
        aria-disabled={isUploading}
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        onKeyDown={handleZoneKeyDown}
        onClick={(e) => {
          if (e.target !== fileInputRef.current && !isUploading) fileInputRef.current?.click();
        }}
        className={`group relative overflow-hidden rounded-3xl border-2 border-dashed p-8 text-center transition-all duration-200 sm:p-12 ${
          isDragOver
            ? 'scale-[0.995] border-indigo-500 bg-indigo-50/70 shadow-md shadow-indigo-100'
            : 'border-indigo-300 bg-gradient-to-b from-indigo-50/50 to-white shadow-sm hover:border-indigo-500 hover:shadow-md hover:shadow-indigo-100/70'
        } ${isUploading ? 'cursor-wait opacity-70' : 'cursor-pointer focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-indigo-100'}`}
      >
        <div className="pointer-events-none absolute inset-x-1/4 top-0 h-24 rounded-full bg-indigo-200/20 blur-3xl transition-opacity group-hover:opacity-100" />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.jpg,.jpeg,.png,.tif,.tiff,.xlsx,.xls,.csv"
          onChange={handleFileInputChange}
          disabled={isUploading}
          className="hidden"
        />

        <div className="relative mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-indigo-100 bg-white text-indigo-600 shadow-md shadow-indigo-100">
          {isUploading ? (
            <Loader2 className="h-7 w-7 animate-spin text-indigo-600" />
          ) : (
            <FileUp className="h-7 w-7" />
          )}
        </div>

        <div className="relative text-lg font-bold tracking-tight text-slate-950 sm:text-xl">
          {isUploading ? 'Uploading & Enqueueing Documents...' : 'Drop Documents Here or Click to Browse'}
        </div>
        <div className="relative mx-auto mt-2 max-w-lg text-sm leading-6 text-slate-500">
          Support for PDF (digital & scanned), PNG, JPG, TIFF, XLSX (multi-sheet), legacy XLS, and CSV.
        </div>
        <div className="relative mt-3 flex flex-wrap items-center justify-center gap-2">
          {FORMAT_BADGES.map(({ label, Icon }) => (
            <span
              key={label}
              className="inline-flex items-center gap-1.5 rounded-full border border-slate-200/80 bg-white/90 px-3 py-1.5 text-[11px] font-semibold text-slate-600 shadow-2xs"
            >
              <Icon className="h-3.5 w-3.5 text-indigo-600" />
              {label}
            </span>
          ))}
        </div>
        <div className="relative mt-4 text-xs text-slate-400">
          Up to 25 MB per file <span className="mx-1.5 text-slate-300">·</span> Multiple files supported
        </div>
      </div>

      {/* Upload Feedback Error Banner */}
      {uploadError && (
        <div className="p-3 bg-rose-50 border border-rose-200 rounded-md text-xs text-rose-800 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
          <div className="flex-1">
            <span className="font-semibold">Upload Validation Warning: </span>
            {uploadError}
          </div>
          <button
            onClick={() => setUploadError(null)}
            className="text-xs text-rose-500 hover:text-rose-800"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Demo Fixtures Panel */}
      <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs sm:p-6">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-500" />
            <span className="text-xs font-semibold text-slate-900">
              Verified Test Fixtures (Demo Pipeline)
            </span>
          </div>
          <span className="text-[11px] text-slate-400 font-mono">
            Direct REST Injection
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {DEMO_FIXTURES.map((fixture) => {
            const isLoadingThis = loadingFixtureId === fixture.id;
            return (
              <button
                key={fixture.id}
                onClick={() => handleLoadFixture(fixture)}
                disabled={isUploading || isLoadingThis}
                className="flex cursor-pointer flex-col justify-between rounded-xl border border-slate-200/80 bg-white p-3 text-left transition-all hover:-translate-y-0.5 hover:border-indigo-200 hover:bg-indigo-50/30 hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
              >
                <div>
                  <div className="flex items-center justify-between gap-1 mb-1">
                    <span className="text-xs font-medium text-slate-900 truncate">
                      {fixture.label}
                    </span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 shrink-0">
                      {fixture.badge}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500 line-clamp-2">
                    {fixture.description}
                  </p>
                </div>
                <div className="mt-2 pt-2 border-t border-slate-100 flex items-center justify-between text-[11px] text-indigo-600 font-medium">
                  <span>{isLoadingThis ? 'Enqueueing...' : 'Ingest Sample'}</span>
                  {isLoadingThis ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Upload className="w-3 h-3" />
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
