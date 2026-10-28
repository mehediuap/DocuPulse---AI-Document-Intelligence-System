import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';

const DATASET_DIR = path.resolve('evaluation/dataset');

export function createDigitalPdf(
  invoiceNo: string,
  date: string,
  supplier: string,
  customer: string | null,
  subtotal: number | null,
  tax: number | null,
  total: number,
  currency: string,
  items: Array<{ desc: string; qty: number; unitPrice: number; amount: number }>,
  pages = 1
): Buffer {
  let content = `%PDF-1.4\n`;
  content += `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`;
  content += `2 0 obj\n<< /Type /Pages /Kids [`;
  for (let i = 1; i <= pages; i++) content += `${2 + i} 0 R `;
  content += `] /Count ${pages} >>\nendobj\n`;

  for (let p = 1; p <= pages; p++) {
    const streamId = 2 + pages + p;
    content += `${2 + p} 0 obj\n<< /Type /Page /Parent 2 0 R /Contents ${streamId} 0 R >>\nendobj\n`;
  }

  if (pages === 1) {
    let text = `BT /F1 12 Tf 50 720 Td (Invoice: ${invoiceNo}) Tj ET\n`;
    text += `BT /F1 10 Tf 50 700 Td (Date: ${date}) Tj ET\n`;
    text += `BT /F1 10 Tf 50 680 Td (Supplier: ${supplier}) Tj ET\n`;
    if (customer) text += `BT /F1 10 Tf 50 660 Td (Customer: ${customer}) Tj ET\n`;
    if (subtotal !== null) text += `BT /F1 10 Tf 50 640 Td (Subtotal: ${subtotal.toFixed(2)}) Tj ET\n`;
    if (tax !== null) text += `BT /F1 10 Tf 50 620 Td (Tax: ${tax.toFixed(2)}) Tj ET\n`;
    text += `BT /F1 10 Tf 50 600 Td (Total: ${total.toFixed(2)} ${currency}) Tj ET\n`;

    let y = 560;
    for (const item of items) {
      text += `BT /F1 9 Tf 50 ${y} Td (${item.desc} ${item.qty} ${item.unitPrice.toFixed(2)} ${item.amount.toFixed(2)}) Tj ET\n`;
      y -= 20;
    }

    const streamId = 2 + pages + 1;
    content += `${streamId} 0 obj\n<< /Length ${text.length} >>\nstream\n${text}\nendstream\nendobj\n`;
  } else {
    // Page 1: Header + Line Items
    let page1Text = `BT /F1 12 Tf 50 720 Td (Invoice: ${invoiceNo} Page 1) Tj ET\n`;
    page1Text += `BT /F1 10 Tf 50 700 Td (Date: ${date}) Tj ET\n`;
    page1Text += `BT /F1 10 Tf 50 680 Td (Supplier: ${supplier}) Tj ET\n`;
    if (customer) page1Text += `BT /F1 10 Tf 50 660 Td (Customer: ${customer}) Tj ET\n`;
    let y = 620;
    for (const item of items) {
      page1Text += `BT /F1 9 Tf 50 ${y} Td (${item.desc} ${item.qty} ${item.unitPrice.toFixed(2)} ${item.amount.toFixed(2)}) Tj ET\n`;
      y -= 20;
    }
    const stream1 = 2 + pages + 1;
    content += `${stream1} 0 obj\n<< /Length ${page1Text.length} >>\nstream\n${page1Text}\nendstream\nendobj\n`;

    // Page 2: Summary Totals
    let page2Text = `BT /F1 12 Tf 50 720 Td (Invoice: ${invoiceNo} Page 2) Tj ET\n`;
    if (subtotal !== null) page2Text += `BT /F1 10 Tf 50 700 Td (Subtotal: ${subtotal.toFixed(2)}) Tj ET\n`;
    if (tax !== null) page2Text += `BT /F1 10 Tf 50 680 Td (Tax: ${tax.toFixed(2)}) Tj ET\n`;
    page2Text += `BT /F1 10 Tf 50 660 Td (Total: ${total.toFixed(2)} ${currency}) Tj ET\n`;
    const stream2 = 2 + pages + 2;
    content += `${stream2} 0 obj\n<< /Length ${page2Text.length} >>\nstream\n${page2Text}\nendstream\nendobj\n`;
  }

  content += `xref\n0 ${3 + pages * 2}\n0000000000 65535 f \n`;
  content += `trailer\n<< /Root 1 0 R /Size ${3 + pages * 2} >>\nstartxref\n${content.length}\n%%EOF\n`;

  return Buffer.from(content, 'utf-8');
}

export function createPngReceipt(
  invoiceNo: string,
  date: string,
  supplier: string,
  customer: string,
  subtotal: number,
  tax: number,
  total: number,
  currency: string,
  items: Array<{ desc: string; qty: number; unitPrice: number; amount: number }>
): Buffer {
  // Valid PNG Header + IHDR Chunk + embedded printable ASCII stream for OCR engine
  const pngSignature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  const ihdrChunk = [
    0x00, 0x00, 0x00, 0x0D, // Length 13
    0x49, 0x48, 0x44, 0x52, // 'IHDR'
    0x00, 0x00, 0x03, 0x20, // Width 800
    0x00, 0x00, 0x04, 0xB0, // Height 1200
    0x08, 0x02, 0x00, 0x00, 0x00, // 8-bit truecolor
    0x00, 0x00, 0x00, 0x00  // CRC placeholder
  ];

  let textPayload = `\nInvoice: ${invoiceNo}\nDate: ${date}\nSupplier: ${supplier}\nCustomer: ${customer}\nSubtotal: ${subtotal.toFixed(2)}\nTax: ${tax.toFixed(2)}\nTotal: ${total.toFixed(2)} ${currency}\n`;
  for (const it of items) {
    textPayload += `${it.desc} ${it.qty} ${it.unitPrice.toFixed(2)} ${it.amount.toFixed(2)}\n`;
  }

  const iendChunk = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82];
  const payloadBytes = Buffer.from(textPayload, 'utf-8');

  return Buffer.concat([
    Buffer.from(pngSignature),
    Buffer.from(ihdrChunk),
    payloadBytes,
    Buffer.from(iendChunk)
  ]);
}

export function createExcelInvoice(
  invoiceNo: string,
  date: string,
  supplier: string,
  customer: string,
  subtotal: number,
  tax: number,
  total: number,
  currency: string,
  items: Array<{ desc: string; qty: number; unitPrice: number; amount: number }>
): Buffer {
  const wb = XLSX.utils.book_new();

  const summary = [
    ['Field', 'Value'],
    ['Invoice Number', invoiceNo],
    ['Date', date],
    ['Supplier', supplier],
    ['Customer', customer],
    ['Subtotal', subtotal],
    ['Tax', tax],
    ['Total', total],
    ['Currency', currency]
  ];

  const itemsRows = [
    ['Description', 'Quantity', 'Unit Price', 'Amount']
  ];
  for (const it of items) {
    itemsRows.push([it.desc, String(it.qty), it.unitPrice.toFixed(2), it.amount.toFixed(2)]);
  }

  const wsSummary = XLSX.utils.aoa_to_sheet(summary);
  const wsItems = XLSX.utils.aoa_to_sheet(itemsRows);

  XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');
  XLSX.utils.book_append_sheet(wb, wsItems, 'LineItems');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

export function generateDatasetFiles() {
  if (!fs.existsSync(DATASET_DIR)) {
    fs.mkdirSync(DATASET_DIR, { recursive: true });
  }

  // 1. DOC-EVAL-001 (Digital PDF)
  fs.writeFileSync(
    path.join(DATASET_DIR, 'INV-2026-001-ApexCloud.pdf'),
    createDigitalPdf(
      'INV-2026-001',
      '2026-03-15',
      'Apex Cloud Services LLC',
      'Global Logistics Group',
      1250.00,
      125.00,
      1375.00,
      'USD',
      [
        { desc: 'Cloud Hosting Cluster', qty: 1, unitPrice: 750.00, amount: 750.00 },
        { desc: 'Database Storage Tier', qty: 1, unitPrice: 500.00, amount: 500.00 }
      ],
      1
    )
  );

  // 2. DOC-EVAL-002 (Multi-page PDF)
  fs.writeFileSync(
    path.join(DATASET_DIR, 'INV-2026-002-EnterpriseNetworks.pdf'),
    createDigitalPdf(
      'INV-2026-002',
      '2026-03-27',
      'Enterprise Data Networks Ltd',
      'Horizon Financial Corp',
      8500.00,
      850.00,
      9350.00,
      'USD',
      [
        { desc: 'Fiber Gateway Transit', qty: 2, unitPrice: 2000.00, amount: 4000.00 },
        { desc: 'Network Security Suite', qty: 1, unitPrice: 3000.00, amount: 3000.00 },
        { desc: 'Direct Connect Circuit', qty: 1, unitPrice: 1500.00, amount: 1500.00 }
      ],
      2
    )
  );

  // 3. DOC-EVAL-003 (CSV comma RFC-4180)
  const csv3 = [
    'Invoice Number,Date,Supplier,Customer,Subtotal,Tax,Total,Currency',
    'INV-2026-003,2026-03-18,"Nordic Tech Solutions","Vanguard Retail Corp",4500.00,450.00,4950.00,USD',
    'Description,Quantity,Unit Price,Amount',
    'Cloud Architecture Consulting,10,300.00,3000.00',
    'Security Hardening Review,5,200.00,1000.00',
    'DevOps Pipeline Automation,1,500.00,500.00'
  ].join('\n');
  fs.writeFileSync(path.join(DATASET_DIR, 'INV-2026-003-NordicTech.csv'), Buffer.from(csv3, 'utf-8'));

  // 4. DOC-EVAL-004 (Multi-sheet XLSX)
  fs.writeFileSync(
    path.join(DATASET_DIR, 'INV-2026-004-PrecisionHardware.xlsx'),
    createExcelInvoice(
      'INV-2026-004',
      '2026-03-20',
      'Precision Hardware Systems',
      'Summit Engineering',
      3200.00,
      320.00,
      3520.00,
      'USD',
      [
        { desc: 'Industrial Compute Node', qty: 2, unitPrice: 1200.00, amount: 2400.00 },
        { desc: 'Thermal Sensor Assembly', qty: 4, unitPrice: 200.00, amount: 800.00 }
      ]
    )
  );

  // 5. DOC-EVAL-005 (PNG receipt)
  fs.writeFileSync(
    path.join(DATASET_DIR, 'INV-2026-005-BeaconSupplies.png'),
    createPngReceipt(
      'INV-2026-005',
      '2026-03-22',
      'Beacon Office Supplies',
      'Delta Dynamics',
      800.00,
      800.00 * 0.10,
      880.00,
      'USD',
      [
        { desc: 'Ergonomic Monitor Arm', qty: 2, unitPrice: 250.00, amount: 500.00 },
        { desc: 'Wireless Peripheral Kit', qty: 3, unitPrice: 100.00, amount: 300.00 }
      ]
    )
  );

  // 6. DOC-EVAL-006 (Semicolon CSV with EUR)
  const csv6 = [
    'Invoice Number;Date;Supplier;Customer;Subtotal;Tax;Total;Currency',
    'INV-2026-006;2026-03-25;EuroScale Cloud GmbH;Bavaria Mobility AG;6200.00;1178.00;7378.00;EUR',
    'Description;Quantity;Unit Price;Amount',
    'Dedicated Cloud Kubernetes;2;2500.00;5000.00',
    'Enterprise Support SLA;1;1200.00;1200.00'
  ].join('\n');
  fs.writeFileSync(path.join(DATASET_DIR, 'INV-2026-006-EuroScale.csv'), Buffer.from(csv6, 'utf-8'));

  // 7. DOC-EVAL-007 (Incomplete PDF - missing customer & subtotal)
  fs.writeFileSync(
    path.join(DATASET_DIR, 'INV-2026-007-QuickPrint.pdf'),
    createDigitalPdf(
      'INV-2026-007',
      '2026-03-28',
      'QuickPrint Services',
      null, // missing customer
      null, // missing subtotal
      15.00,
      165.00,
      '', // missing currency triggers MISSING_CURRENCY warning (needs_review)
      [
        { desc: 'Express Document Binding', qty: 1, unitPrice: 150.00, amount: 150.00 }
      ],
      1
    )
  );

  // 8. DOC-EVAL-008 (XLSX with math mismatch)
  fs.writeFileSync(
    path.join(DATASET_DIR, 'INV-2026-008-StarlightMedia.xlsx'),
    createExcelInvoice(
      'INV-2026-008',
      '2026-03-29',
      'Starlight Media Group',
      'Acme Distribution',
      2000.00,
      200.00,
      2450.00, // Intentional mismatch: 2000 + 200 != 2450
      'USD',
      [
        { desc: 'Video Production Master', qty: 1, unitPrice: 1500.00, amount: 1500.00 },
        { desc: 'Motion Graphic Design', qty: 1, unitPrice: 500.00, amount: 500.00 }
      ]
    )
  );

  // 9. DOC-EVAL-009 (Duplicate candidate of 001)
  const csv9 = [
    'Invoice Number,Date,Supplier,Customer,Subtotal,Tax,Total,Currency',
    'INV-2026-001,2026-03-30,"Apex Cloud Services LLC","Global Logistics Group",1250.00,125.00,1375.00,USD',
    'Description,Quantity,Unit Price,Amount',
    'Cloud Hosting Cluster,1,750.00,750.00',
    'Database Storage Tier,1,500.00,500.00'
  ].join('\n');
  fs.writeFileSync(path.join(DATASET_DIR, 'INV-2026-009-DuplicateCandidate.csv'), Buffer.from(csv9, 'utf-8'));

  // 10. DOC-EVAL-010 (Corrupt payload)
  const corruptBytes = Buffer.from([0x00, 0xFF, 0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x12, 0x34]);
  fs.writeFileSync(path.join(DATASET_DIR, 'INV-2026-010-CorruptPayload.pdf'), corruptBytes);

  console.log(`Generated 10 evaluation documents in ${DATASET_DIR}`);
}

if (import.meta.url.endsWith(process.argv[1]) || process.argv[1]?.includes('generate_dataset')) {
  generateDatasetFiles();
}
