/**
 * Sample Test Fixtures Generator for DocuPulse Frontend Demo
 * Clearly labeled synthetic test fixtures used to demonstrate ingestion, extraction,
 * validation alerts, math discrepancies, and error handling through live REST APIs.
 */

function createFixtureFile(name: string, type: string, bytes: Uint8Array): File {
  return new File([bytes.slice().buffer as ArrayBuffer], name, { type });
}

function createPdfBytes(content: string): Uint8Array {
  const encoder = new TextEncoder();
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`,
  ];
  const chunks: Uint8Array[] = [encoder.encode('%PDF-1.7\n')];
  const offsets = [0];
  let length = chunks[0].length;

  objects.forEach((object, index) => {
    offsets.push(length);
    const chunk = encoder.encode(`${index + 1} 0 obj\n${object}\nendobj\n`);
    chunks.push(chunk);
    length += chunk.length;
  });

  const xrefOffset = length;
  const xref = [
    `xref\n0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n `),
  ].join('\n');
  chunks.push(encoder.encode(
    `${xref}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  ));
  length = chunks.reduce((total, chunk) => total + chunk.length, 0);

  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function createDigitalPdfBytes(invoiceNumber: string): Uint8Array {
  const escape = (value: string) => value.replace(/[\\()]/g, '\\$&');
  const lines = [
    `Invoice Number: ${escape(invoiceNumber)}`,
    'Invoice Date: 2026-03-15',
    'Supplier: Global Apex Logistics Ltd',
    'Customer: Global Logistics Group',
    'Subtotal: 1250.00 Tax: 125.00 Total: 1375.00 USD',
  ];
  const content = lines.map((line, index) =>
    `BT /F1 12 Tf 50 ${700 - index * 20} Td (${line}) Tj ET`
  ).join('\n');
  return createPdfBytes(content);
}

function createScannedPdfBytes(): Uint8Array {
  return createPdfBytes('q Q');
}

async function createMultiSheetXlsx(): Promise<Uint8Array> {
  const XLSX = await import('xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Invoice Number', 'Issue Date', 'Customer', 'Total'],
    ['INV-2026-889', '2026-10-15', 'Vertex BioPharma', 14250],
  ]), 'Summary');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Item Code', 'Description', 'Quantity', 'Unit Price', 'Amount'],
    ['ITM-01', 'High Precision Actuator', 4, 2500, 10000],
  ]), 'LineItems');
  return new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }));
}

export interface DemoFixture {
  id: string;
  label: string;
  description: string;
  badge: string;
  generate: () => File | Promise<File>;
}

export const DEMO_FIXTURES: DemoFixture[] = [
  {
    id: 'compliant-pdf',
    label: 'Standard Compliant Invoice',
    description: 'Digital PDF with matching totals ($1,250.00 subtotal + $125.00 tax = $1,375.00 total)',
    badge: 'Expected: Completed',
    generate: () => {
      const bytes = createDigitalPdfBytes('INV-2026-8801');
      return createFixtureFile('invoice_compliant_8801.pdf', 'application/pdf', bytes);
    },
  },
  {
    id: 'math-mismatch-pdf',
    label: 'Math Mismatch / Review Flag',
    description: 'Invoice with arithmetic discrepancy between subtotal, tax, and total',
    badge: 'Expected: Needs Review',
    generate: () => {
      // Craft a PDF text stream where Total doesn't match Subtotal + Tax
      const text =
        `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n` +
        `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n` +
        `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n` +
        `4 0 obj\n<< /Length 280 >>\nstream\n` +
        `INVOICE\n` +
        `Invoice Number: INV-DISCREPANCY-99\n` +
        `Invoice Date: 2026-03-15\n` +
        `Supplier Name: Quantum Dynamics Ltd\n` +
        `Customer Name: Global Horizon Systems\n` +
        `Subtotal: $4,500.00\n` +
        `Tax: $450.00\n` +
        `Total: $5,800.00\n` + // Intentional mismatch ($4500 + $450 != $5800)
        `Currency: USD\n` +
        `Line 1: Server Chassis 2U | Qty: 2 | Unit: $2,250.00 | Total: $4,500.00\n` +
        `endstream\nendobj\nxref\n0 5\n0000000000 65535 f \n` +
        `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n500\n%%EOF`;
      const bytes = new TextEncoder().encode(text);
      return createFixtureFile('invoice_math_discrepancy.pdf', 'application/pdf', bytes);
    },
  },
  {
    id: 'duplicate-candidate',
    label: 'Duplicate Invoice Candidate',
    description: 'Invoice sharing supplier "Quantum Dynamics Ltd" and ID "INV-DISCREPANCY-99"',
    badge: 'Expected: Duplicate Alert',
    generate: () => {
      const text =
        `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n` +
        `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n` +
        `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n` +
        `4 0 obj\n<< /Length 260 >>\nstream\n` +
        `INVOICE\n` +
        `Invoice Number: INV-DISCREPANCY-99\n` +
        `Invoice Date: 2026-03-20\n` +
        `Supplier Name: Quantum Dynamics Ltd\n` +
        `Customer Name: Acme Logistics Inc\n` +
        `Subtotal: $1,200.00\n` +
        `Tax: $120.00\n` +
        `Total: $1,320.00\n` +
        `Currency: USD\n` +
        `endstream\nendobj\nxref\n0 5\n0000000000 65535 f \n` +
        `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n500\n%%EOF`;
      const bytes = new TextEncoder().encode(text);
      return createFixtureFile('invoice_duplicate_suspect.pdf', 'application/pdf', bytes);
    },
  },
  {
    id: 'scanned-receipt',
    label: 'Scanned Raster Receipt',
    description: 'Simulated raster image routing through OCR layout parser',
    badge: 'OCR Route',
    generate: () => {
      const bytes = createScannedPdfBytes();
      return createFixtureFile('scanned_logistics_receipt.pdf', 'application/pdf', bytes);
    },
  },
  {
    id: 'xlsx-multisheet',
    label: 'Multi-Sheet XLSX Ledger',
    description: 'OpenXML spreadsheet with 2 preserved worksheets & coordinate grids',
    badge: 'Spreadsheet',
    generate: async () => {
      const bytes = await createMultiSheetXlsx();
      return createFixtureFile(
        'procurement_ledger_2026.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        bytes
      );
    },
  },
  {
    id: 'delimited-csv',
    label: 'Semicolon Delimited CSV',
    description: 'Vendor billing with semicolon delimiters and quoted currency values',
    badge: 'CSV Table',
    generate: () => {
      const csv =
        `"Invoice ID";"Supplier Name";"Line Item";"Quantity";"Unit Price";"Line Total"\n` +
        `"INV-CSV-401";"Helix Cloud Services";"Compute Cluster Instances";4;350.00;1400.00\n` +
        `"INV-CSV-401";"Helix Cloud Services";"Egress Bandwidth Tier 1";1;120.50;120.50\n` +
        `"INV-CSV-401";"Helix Cloud Services";"Direct Connect Gateway";1;250.00;250.00`;
      const bytes = new TextEncoder().encode(csv);
      return createFixtureFile('helix_cloud_billing.csv', 'text/csv', bytes);
    },
  },
  {
    id: 'damaged-stream',
    label: 'Corrupted File Stream',
    description: 'Damaged header bytes to test fault isolation and retry capabilities',
    badge: 'Failure Diagnostic',
    generate: () => {
      const bytes = new TextEncoder().encode('%PDF-CORRUPTED_STREAM_HEADER_FAULT_0x00FF');
      return createFixtureFile('corrupted_transmission.pdf', 'application/pdf', bytes);
    },
  },
];
