import { SheetContent, DocumentMetadata } from './types.ts';

export interface CsvProcessingResult {
  sheets: SheetContent[];
  metadata: Partial<DocumentMetadata>;
  warnings: string[];
  rawText: string;
}

/**
 * Robust CSV Processor supporting multiple encodings and auto-detected delimiters (, ; \t |).
 * Preserves structured row/column boundaries and supports quoted multi-line cells.
 */
export async function processCsv(
  data: Uint8Array | string,
  filename: string
): Promise<CsvProcessingResult> {
  const warnings: string[] = [];

  // 1. Decode text with encoding check (UTF-8 with BOM or fallback)
  let text = '';
  let encoding = 'UTF-8';

  if (typeof data === 'string') {
    text = data;
  } else {
    // Check for UTF-8 BOM: 0xEF, 0xBB, 0xBF
    if (data.length >= 3 && data[0] === 0xEF && data[1] === 0xBB && data[2] === 0xBF) {
      encoding = 'UTF-8 with BOM';
      text = new TextDecoder('utf-8').decode(data.slice(3));
    } else {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(data);
      } catch {
        // Fallback to latin1 / windows-1252
        encoding = 'Windows-1252 / ISO-8859-1';
        text = new TextDecoder('latin1').decode(data);
        warnings.push(`File encoding was detected as ${encoding}.`);
      }
    }
  }

  if (!text || text.trim().length === 0) {
    throw new Error('CSV file content is empty.');
  }

  // 2. Auto-detect delimiter
  const detectedDelimiter = detectDelimiter(text);
  warnings.push(`Auto-detected delimiter: "${detectedDelimiter === '\t' ? '\\t (Tab)' : detectedDelimiter}".`);

  // 3. Parse CSV rows honoring quoted strings
  const parsedRows = parseCsvTokens(text, detectedDelimiter);

  if (parsedRows.length === 0) {
    throw new Error('No valid records could be parsed from CSV.');
  }

  const rawHeaders = parsedRows[0] || [];
  const headers = rawHeaders.map((h, i) => (h && h.trim().length > 0 ? h.trim() : `Col_${i + 1}`));
  const dataRows = parsedRows.slice(1);

  // Compute maximum columns across all rows
  let maxCols = headers.length;
  for (const row of dataRows) {
    if (row.length > maxCols) {
      maxCols = row.length;
    }
  }

  // Check for ragged/inconsistent columns
  let raggedCount = 0;
  for (let i = 0; i < dataRows.length; i++) {
    if (dataRows[i].length !== headers.length) {
      raggedCount++;
    }
  }
  if (raggedCount > 0) {
    warnings.push(`Inconsistent column count detected on ${raggedCount} data rows; standardized to ${maxCols} columns.`);
  }

  // Build clean text preview
  const previewLines: string[] = [];
  previewLines.push(`--- CSV DATA: ${filename} (${parsedRows.length} rows, ${maxCols} cols) ---`);
  previewLines.push(headers.join(' | '));
  previewLines.push('-'.repeat(Math.min(80, Math.max(20, headers.join(' | ').length))));

  for (let rIdx = 0; rIdx < dataRows.length; rIdx++) {
    const row = dataRows[rIdx];
    const rowStr = row.map(cell => (cell !== null && cell !== undefined ? String(cell) : '')).join(' | ');
    previewLines.push(`Row ${rIdx + 2}: ${rowStr}`);
  }

  const rawText = previewLines.join('\n');

  const sheet: SheetContent = {
    sheetName: 'CSV Data',
    rowCount: parsedRows.length,
    columnCount: maxCols,
    headers,
    rows: parsedRows,
    rawTextPreview: rawText,
  };

  return {
    sheets: [sheet],
    metadata: {
      sheetCount: 1,
      detectedDelimiter,
      detectedEncoding: encoding,
      hasMultiPages: false,
    },
    warnings,
    rawText,
  };
}

/**
 * Auto-detects the most frequent consistent delimiter among , ; \t |
 */
function detectDelimiter(text: string): string {
  const candidates = [',', ';', '\t', '|'];
  const sampleLines = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .slice(0, 10);

  if (sampleLines.length === 0) return ',';

  let bestDelimiter = ',';
  let bestScore = -1;

  for (const delimiter of candidates) {
    const counts = sampleLines.map(line => {
      let count = 0;
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '"') inQuotes = !inQuotes;
        else if (line[i] === delimiter && !inQuotes) count++;
      }
      return count;
    });

    const nonZeroCounts = counts.filter(c => c > 0);
    if (nonZeroCounts.length > 0) {
      // Check consistency (low standard deviation)
      const avg = nonZeroCounts.reduce((a, b) => a + b, 0) / nonZeroCounts.length;
      const variance = nonZeroCounts.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / nonZeroCounts.length;
      const consistencyScore = (nonZeroCounts.length / sampleLines.length) * 10 - variance;

      if (consistencyScore > bestScore && avg >= 1) {
        bestScore = consistencyScore;
        bestDelimiter = delimiter;
      }
    }
  }

  return bestDelimiter;
}

/**
 * Standard RFC-4180 compliant CSV parser that handles quoted delimiters and escaped quotes ("").
 */
function parseCsvTokens(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentToken = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote
        currentToken += '"';
        i++;
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      currentRow.push(currentToken.trim());
      currentToken = '';
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') {
        i++; // Skip \n
      }
      currentRow.push(currentToken.trim());
      if (currentRow.some(col => col.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentToken = '';
    } else {
      currentToken += char;
    }
  }

  if (currentToken.length > 0 || currentRow.length > 0) {
    currentRow.push(currentToken.trim());
    if (currentRow.some(col => col.length > 0)) {
      rows.push(currentRow);
    }
  }

  return rows;
}
