import { SupportedFileType } from './types.ts';

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB max limit

/**
 * Strips path traversal attempts (../, ..\, null bytes, absolute paths)
 * and normalizes filename into a safe alphanumeric string with extension.
 */
export function sanitizeFilename(rawName: string): string {
  if (!rawName || typeof rawName !== 'string') {
    return 'document_unnamed';
  }

  // Remove null bytes
  let safe = rawName.replace(/\0/g, '');

  // Strip leading/trailing whitespaces and control characters
  safe = safe.trim();

  // Strip path traversal prefixes (e.g. ../, ..\, /etc/passwd, C:\windows\)
  safe = safe.replace(/^(?:\.\.[\\/])+|^(?:[a-zA-Z]:[\\/])|^[\\/]+/g, '');
  safe = safe.split(/[\\/]/).pop() || 'document';

  // Remove shell special characters, quotes, and dangerous symbols
  safe = safe.replace(/[^a-zA-Z0-9._-]/g, '_');

  // Prevent hidden dotfiles or empty stems like "..pdf" or ".env"
  if (safe.startsWith('.')) {
    safe = 'doc' + safe;
  }

  // Cap max length to prevent filesystem overflow attacks
  if (safe.length > 120) {
    const ext = safe.includes('.') ? safe.substring(safe.lastIndexOf('.')) : '';
    safe = safe.substring(0, 110) + ext;
  }

  return safe || 'document';
}

/**
 * Validates file size boundaries (non-empty and not oversized).
 */
export function validateFileBounds(size: number, maxBytes = MAX_FILE_SIZE_BYTES): { valid: boolean; error?: string } {
  if (size <= 0) {
    return {
      valid: false,
      error: 'File is empty (0 bytes). Document processing requires non-empty data.'
    };
  }

  if (size > maxBytes) {
    return {
      valid: false,
      error: `File size (${formatBytes(size)}) exceeds maximum allowed threshold of ${formatBytes(maxBytes)}.`
    };
  }

  return { valid: true };
}

/**
 * Human-readable byte formatting helper.
 */
export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/**
 * Inspects file extension and magic byte headers to determine supported file type.
 */
export function detectFileType(filename: string, headerBytes?: Uint8Array): SupportedFileType {
  const ext = filename.split('.').pop()?.toLowerCase();

  // Inspect magic bytes if available for strong verification
  if (headerBytes && headerBytes.length >= 4) {
    // PDF: %PDF (0x25 0x50 0x44 0x46)
    if (headerBytes[0] === 0x25 && headerBytes[1] === 0x50 && headerBytes[2] === 0x44 && headerBytes[3] === 0x46) {
      return 'pdf';
    }

    // PNG: \x89PNG (0x89 0x50 0x4E 0x47)
    if (headerBytes[0] === 0x89 && headerBytes[1] === 0x50 && headerBytes[2] === 0x4E && headerBytes[3] === 0x47) {
      return 'image';
    }

    // JPEG: 0xFF 0xD8 0xFF
    if (headerBytes[0] === 0xFF && headerBytes[1] === 0xD8 && headerBytes[2] === 0xFF) {
      return 'image';
    }

    // TIFF Little-Endian: "II*\0" (0x49 0x49 0x2A 0x00)
    // TIFF Big-Endian: "MM\0*" (0x4D 0x4D 0x00 0x2A)
    if (
      (headerBytes[0] === 0x49 && headerBytes[1] === 0x49 && headerBytes[2] === 0x2A && headerBytes[3] === 0x00) ||
      (headerBytes[0] === 0x4D && headerBytes[1] === 0x4D && headerBytes[2] === 0x00 && headerBytes[3] === 0x2A)
    ) {
      return 'image';
    }

    // Legacy XLS (OLE Compound Document): 0xD0 0xCF 0x11 0xE0
    if (headerBytes[0] === 0xD0 && headerBytes[1] === 0xCF && headerBytes[2] === 0x11 && headerBytes[3] === 0xE0) {
      return 'xls';
    }

    // XLSX / ZIP archive: "PK\x03\x04" (0x50 0x4B 0x03 0x04)
    if (headerBytes[0] === 0x50 && headerBytes[1] === 0x4B && headerBytes[2] === 0x03 && headerBytes[3] === 0x04) {
      return 'xlsx';
    }
  }

  // Fallback to extension matching
  switch (ext) {
    case 'pdf':
      return 'pdf';
    case 'jpg':
    case 'jpeg':
    case 'png':
    case 'tif':
    case 'tiff':
      return 'image';
    case 'xlsx':
      return 'xlsx';
    case 'xls':
      return 'xls';
    case 'csv':
      return 'csv';
    default:
      return 'unsupported';
  }
}
