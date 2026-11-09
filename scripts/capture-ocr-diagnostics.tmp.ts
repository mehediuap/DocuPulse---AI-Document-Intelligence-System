import fs from 'node:fs';
import path from 'node:path';
import { documentPipeline } from '../src/services/document/documentPipeline.ts';
import { ExtractionFactory } from '../src/services/extraction/llmAdapter.ts';

const root = process.cwd();
const dataset = path.join(root, 'evaluation', 'dataset_independent');
const output = path.join(root, 'docs', 'ocr_diagnostics');
const cases = [
  {
    id: 'I01',
    file: 'I01_clean.png',
    expected: `INVOICE
Invoice No: INV-2026-901
Date: 2026-08-01
Supplier: Lighthouse Paper Co
Customer: Evergreen Publishing

Paper ream   40   6.50   260.00
Toner   3   89.00   267.00

Subtotal: 527.00
Tax: 36.89
Total: 563.89 USD`,
  },
  {
    id: 'I02',
    file: 'I02_skewed_noisy.png',
    expected: `INVOICE
Invoice No: INV-2026-902
Date: 2026-08-02
Supplier: Quarry Stone Works
Customer: Hillcrest Landscaping

Granite slab   4   310.00   1,240.00
Delivery   1   95.00   95.00

Subtotal: 1,335.00
Tax: 106.80
Total: 1,441.80 USD`,
  },
  {
    id: 'I03',
    file: 'I03_low_res.jpg',
    expected: `INVOICE
Invoice No: INV-2026-903
Date: 2026-08-03
Supplier: Tanager Electronics
Customer: Kestrel Labs

Sensor board   25   14.40   360.00

Subtotal: 360.00
Tax: 18.00
Total: 378.00 USD`,
  },
  {
    id: 'S01',
    file: 'S01_scanned.pdf',
    expected: `INVOICE
Invoice No: INV-2026-951
Date: 2026-08-10
Supplier: Orchid Bay Seafood
Customer: Marina Grill Group

Prawns 5kg   12   48.00   576.00
Squid 5kg   8   31.00   248.00

Subtotal: 824.00
Tax: 57.68
Total: 881.68 USD`,
  },
  {
    id: 'S02',
    file: 'S02_scanned_skewed.pdf',
    expected: `INVOICE
Invoice No: INV-2026-952
Date: 2026-08-11
Supplier: Silverline Fabrication
Customer: Northgate Builders

Steel plate   6   142.00   852.00

Subtotal: 852.00
Tax: 68.16
Total: 920.16 USD`,
  },
];

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const previous = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = previous;
    }
  }
  return row[b.length];
}

async function main(): Promise<void> {
  process.env.OCR_PROVIDER = 'tesseract';
  const adapter = ExtractionFactory.createAdapter(true);
  for (const item of cases) {
    const data = fs.readFileSync(path.join(dataset, item.file));
    const [processed] = await documentPipeline.processBatch([{ name: item.file, data, size: data.length }]);
    const raw = (processed.pages ?? []).filter(page => page.isOcr).map(page => page.text).join('\n\n');
    fs.writeFileSync(path.join(output, `${item.id}_raw.txt`), `${raw}\n`, 'utf8');
    const normalize = (text: string) => text.toLowerCase().replace(/\s/g, '');
    const expected = normalize(item.expected);
    const actual = normalize(raw);
    const accuracy = (1 - distance(expected, actual) / Math.max(expected.length, actual.length)) * 100;
    const extracted = await adapter.extract(processed.rawText);
    console.log(JSON.stringify({ id: item.id, characterAccuracy: Number(accuracy.toFixed(2)), expectedCharacters: expected.length, actualCharacters: actual.length, ocr: raw, extracted }));
  }
}

void main();
