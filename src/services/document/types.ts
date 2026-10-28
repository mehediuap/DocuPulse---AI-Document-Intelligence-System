/**
 * Document Intelligence System - Document Processing Types
 */

export type SupportedFileType = 'pdf' | 'image' | 'xlsx' | 'xls' | 'csv' | 'unsupported';

export type DocumentProcessingStatus = 'pending' | 'processing' | 'completed' | 'warning' | 'failed';

export interface PageContent {
  pageNumber: number;
  text: string;
  lineCount: number;
  isOcr?: boolean;
  confidence?: number;
  lines?: string[];
}

export interface SheetContent {
  sheetName: string;
  rowCount: number;
  columnCount: number;
  headers: string[];
  rows: (string | number | null)[][];
  rawTextPreview: string;
}

export interface DocumentMetadata {
  fileSizeBytes: number;
  fileSizeFormatted: string;
  mimeType: string;
  pageCount?: number;
  sheetCount?: number;
  dimensions?: {
    width: number;
    height: number;
  };
  detectedDelimiter?: string;
  detectedEncoding?: string;
  isScanned?: boolean;
  hasMultiPages?: boolean;
}

export interface ProcessedDocument {
  id: string;
  originalFilename: string;
  sanitizedFilename: string;
  fileType: SupportedFileType;
  mimeType: string;
  fileSizeBytes: number;
  status: DocumentProcessingStatus;
  uploadedAt: string;
  processedAt?: string;
  processingDurationMs: number;
  
  // Extracted content maintaining boundaries
  pages?: PageContent[];
  sheets?: SheetContent[];
  rawText: string;
  
  // Metadata & structural details
  metadata: DocumentMetadata;
  
  // Auditing and errors
  warnings: string[];
  errors: string[];
}

export interface FileProcessingInput {
  name: string;
  size: number;
  type?: string;
  data: Uint8Array | ArrayBuffer | string;
}

export interface ProcessingResult {
  success: boolean;
  document: ProcessedDocument;
}
