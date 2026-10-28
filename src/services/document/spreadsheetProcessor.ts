import * as XLSX from 'xlsx';
import { SheetContent, DocumentMetadata } from './types.ts';

export interface SpreadsheetProcessingResult {
  sheets: SheetContent[];
  metadata: Partial<DocumentMetadata>;
  warnings: string[];
  rawText: string;
}

/**
 * Robust Spreadsheet Processor for XLSX and legacy XLS files.
 * Preserves multi-sheet boundaries, row/col coordinates, and detects legacy formats.
 */
export async function processSpreadsheet(
  buffer: Uint8Array,
  filename: string,
  fileType: 'xlsx' | 'xls'
): Promise<SpreadsheetProcessingResult> {
  const warnings: string[] = [];
  const sheets: SheetContent[] = [];

  if (fileType === 'xls') {
    warnings.push('Legacy BIFF8/BIFF5 XLS format detected. Processed via backward-compatibility engine.');
  }

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, {
      type: 'array',
      cellDates: true,
      cellNF: true,
      raw: false,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Corrupted or unreadable spreadsheet file: ${msg}`);
  }

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new Error('Spreadsheet contains zero worksheets or invalid workbook structure.');
  }

  if (workbook.SheetNames.length > 1) {
    warnings.push(`Multi-worksheet workbook detected: ${workbook.SheetNames.length} worksheets preserved.`);
  }

  const textSections: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const ws = workbook.Sheets[sheetName];
    if (!ws) continue;

    // Convert to 2D array of rows
    const rawData = XLSX.utils.sheet_to_json<(string | number | null)[]>(ws, {
      header: 1,
      defval: null,
      blankrows: false,
    });

    if (rawData.length === 0) {
      warnings.push(`Worksheet "${sheetName}" is empty.`);
      sheets.push({
        sheetName,
        rowCount: 0,
        columnCount: 0,
        headers: [],
        rows: [],
        rawTextPreview: `[Worksheet "${sheetName}" is empty]`,
      });
      continue;
    }

    // First non-empty row as header candidates
    const firstRow = rawData[0] || [];
    const headers = firstRow.map((val, idx) => (val !== null && val !== undefined ? String(val).trim() : `Col_${idx + 1}`));
    const dataRows = rawData.slice(1);

    // Calculate max columns
    let maxCols = headers.length;
    for (const r of dataRows) {
      if (r && r.length > maxCols) {
        maxCols = r.length;
      }
    }

    // Build formatted tabular preview text
    const previewLines: string[] = [];
    previewLines.push(`--- WORKSHEET: ${sheetName} (${rawData.length} rows, ${maxCols} cols) ---`);
    previewLines.push(headers.join(' | '));
    previewLines.push('-'.repeat(Math.min(80, Math.max(20, headers.join(' | ').length))));

    for (let rIdx = 0; rIdx < dataRows.length; rIdx++) {
      const row = dataRows[rIdx];
      const rowStr = row.map(cell => (cell !== null && cell !== undefined ? String(cell) : '')).join(' | ');
      previewLines.push(`Row ${rIdx + 2}: ${rowStr}`);
    }

    const sheetPreview = previewLines.join('\n');
    textSections.push(sheetPreview);

    sheets.push({
      sheetName,
      rowCount: rawData.length,
      columnCount: maxCols,
      headers,
      rows: rawData,
      rawTextPreview: sheetPreview,
    });
  }

  const rawText = textSections.join('\n\n');

  return {
    sheets,
    metadata: {
      sheetCount: sheets.length,
      hasMultiPages: sheets.length > 1,
    },
    warnings,
    rawText,
  };
}
