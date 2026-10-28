import {
  ProcessedDocument,
  FileProcessingInput,
  SupportedFileType,
  DocumentProcessingStatus,
} from './types.ts';
import {
  sanitizeFilename,
  validateFileBounds,
  detectFileType,
  formatBytes,
} from './security.ts';
import { processPdf } from './pdfProcessor.ts';
import { processImage } from './imageProcessor.ts';
import { processSpreadsheet } from './spreadsheetProcessor.ts';
import { processCsv } from './csvProcessor.ts';

/**
 * Main Document Processing Pipeline Orchestrator.
 * Handles single or multiple file uploads with complete fault-isolation.
 * If one file is corrupted or unsupported, it logs errors and continues processing the rest.
 */
export class DocumentPipeline {
  /**
   * Processes a batch of uploaded files. Faults in one file will not disrupt others.
   */
  public async processBatch(files: FileProcessingInput[]): Promise<ProcessedDocument[]> {
    const results: ProcessedDocument[] = [];

    for (const file of files) {
      try {
        const processed = await this.processSingleFile(file);
        results.push(processed);
      } catch (err) {
        // Defensive outer catch to guarantee the batch loop never terminates prematurely
        const errorMessage = err instanceof Error ? err.message : String(err);
        const docId = `doc_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const safeName = sanitizeFilename(file.name);

        results.push({
          id: docId,
          originalFilename: file.name,
          sanitizedFilename: safeName,
          fileType: 'unsupported',
          mimeType: file.type || 'application/octet-stream',
          fileSizeBytes: file.size || 0,
          status: 'failed',
          uploadedAt: new Date().toISOString(),
          processingDurationMs: 0,
          rawText: '',
          metadata: {
            fileSizeBytes: file.size || 0,
            fileSizeFormatted: formatBytes(file.size || 0),
            mimeType: file.type || 'application/octet-stream',
          },
          warnings: [],
          errors: [`Unexpected pipeline failure: ${errorMessage}`],
        });
      }
    }

    return results;
  }

  /**
   * Processes a single file through validation, format detection, and modular parsing.
   */
  public async processSingleFile(file: FileProcessingInput): Promise<ProcessedDocument> {
    const startTime = performance.now();
    const docId = `doc_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const sanitizedName = sanitizeFilename(file.name);
    const warnings: string[] = [];
    const errors: string[] = [];

    // Check if filename had to be sanitized
    if (file.name !== sanitizedName) {
      warnings.push(`Unsafe filename sanitized: "${file.name}" → "${sanitizedName}"`);
    }

    // Convert input data to Uint8Array
    let buffer: Uint8Array;
    if (typeof file.data === 'string') {
      buffer = new TextEncoder().encode(file.data);
    } else if (file.data instanceof ArrayBuffer) {
      buffer = new Uint8Array(file.data);
    } else if (file.data instanceof Uint8Array) {
      buffer = file.data;
    } else {
      buffer = new Uint8Array(0);
    }

    const actualSize = buffer.byteLength;

    // 1. File Bounds Validation (Empty / Oversized)
    const boundsCheck = validateFileBounds(actualSize);
    if (!boundsCheck.valid) {
      errors.push(boundsCheck.error || 'Invalid file size');
      return {
        id: docId,
        originalFilename: file.name,
        sanitizedFilename: sanitizedName,
        fileType: 'unsupported',
        mimeType: file.type || 'application/octet-stream',
        fileSizeBytes: actualSize,
        status: 'failed',
        uploadedAt: new Date().toISOString(),
        processingDurationMs: Math.round(performance.now() - startTime),
        rawText: '',
        metadata: {
          fileSizeBytes: actualSize,
          fileSizeFormatted: formatBytes(actualSize),
          mimeType: file.type || 'application/octet-stream',
        },
        warnings,
        errors,
      };
    }

    // 2. Format & Magic Byte Detection
    const detectedType = detectFileType(sanitizedName, buffer.slice(0, 16));

    if (detectedType === 'unsupported') {
      errors.push(`Unsupported file format. Supported extensions: .pdf, .jpg, .jpeg, .png, .tif, .tiff, .xlsx, .xls, .csv`);
      return {
        id: docId,
        originalFilename: file.name,
        sanitizedFilename: sanitizedName,
        fileType: 'unsupported',
        mimeType: file.type || 'application/octet-stream',
        fileSizeBytes: actualSize,
        status: 'failed',
        uploadedAt: new Date().toISOString(),
        processingDurationMs: Math.round(performance.now() - startTime),
        rawText: '',
        metadata: {
          fileSizeBytes: actualSize,
          fileSizeFormatted: formatBytes(actualSize),
          mimeType: file.type || 'application/octet-stream',
        },
        warnings,
        errors,
      };
    }

    // 3. Dispatch to modular processors
    let status: DocumentProcessingStatus = 'completed';
    let rawText = '';
    let pages = undefined;
    let sheets = undefined;
    let metadataAdditions: Record<string, any> = {};

    try {
      switch (detectedType) {
        case 'pdf': {
          const pdfRes = await processPdf(buffer, sanitizedName);
          pages = pdfRes.pages;
          rawText = pdfRes.rawText;
          warnings.push(...pdfRes.warnings);
          metadataAdditions = pdfRes.metadata;
          break;
        }

        case 'image': {
          const imgRes = await processImage(buffer, sanitizedName, file.type);
          pages = imgRes.pages;
          rawText = imgRes.rawText;
          warnings.push(...imgRes.warnings);
          metadataAdditions = imgRes.metadata;
          break;
        }

        case 'xlsx':
        case 'xls': {
          const sheetRes = await processSpreadsheet(buffer, sanitizedName, detectedType);
          sheets = sheetRes.sheets;
          rawText = sheetRes.rawText;
          warnings.push(...sheetRes.warnings);
          metadataAdditions = sheetRes.metadata;
          break;
        }

        case 'csv': {
          const csvRes = await processCsv(buffer, sanitizedName);
          sheets = csvRes.sheets;
          rawText = csvRes.rawText;
          warnings.push(...csvRes.warnings);
          metadataAdditions = csvRes.metadata;
          break;
        }
      }
    } catch (parseError) {
      const msg = parseError instanceof Error ? parseError.message : String(parseError);
      errors.push(`Processing error during ${detectedType.toUpperCase()} parsing: ${msg}`);
      status = 'failed';
    }

    if (errors.length > 0) {
      status = 'failed';
    } else if (warnings.length > 0) {
      status = 'warning';
    }

    const duration = Math.round(performance.now() - startTime);

    return {
      id: docId,
      originalFilename: file.name,
      sanitizedFilename: sanitizedName,
      fileType: detectedType,
      mimeType: file.type || getFallbackMime(detectedType),
      fileSizeBytes: actualSize,
      status,
      uploadedAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      processingDurationMs: Math.max(1, duration),
      pages,
      sheets,
      rawText,
      metadata: {
        fileSizeBytes: actualSize,
        fileSizeFormatted: formatBytes(actualSize),
        mimeType: file.type || getFallbackMime(detectedType),
        ...metadataAdditions,
      },
      warnings,
      errors,
    };
  }
}

function getFallbackMime(type: SupportedFileType): string {
  switch (type) {
    case 'pdf': return 'application/pdf';
    case 'image': return 'image/jpeg';
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'xls': return 'application/vnd.ms-excel';
    case 'csv': return 'text/csv';
    default: return 'application/octet-stream';
  }
}

export const documentPipeline = new DocumentPipeline();
