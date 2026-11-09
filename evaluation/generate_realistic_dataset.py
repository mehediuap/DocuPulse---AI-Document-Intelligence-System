#!/usr/bin/env python3
"""
Independent evaluation dataset (v2) for DocuPulse.

Why this exists: the original dataset is produced by the project's own TypeScript generator, which writes
hand-built, uncompressed PDFs, i.e. exactly what the project's parser reads. This script uses real PDF
tooling (reportlab: compressed streams, ASCII85+Flate), varied layouts/labels/date and number formats and
currencies, multi-page invoices, table-layout PDFs, distractor fields, missing fields, an arithmetic error,
a duplicate, scanned/OCR-only inputs and corrupted files.

Ground truth is computed from the SAME Python values that are printed on the page, so it cannot drift.

Usage (from the repo root):
    pip install reportlab openpyxl pillow
    python evaluation/generate_realistic_dataset.py
Outputs: evaluation/dataset_independent/*  and  evaluation/ground_truth_independent.json
"""
import io
import json
import os
import random
from decimal import Decimal as D, ROUND_HALF_UP

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "dataset_independent")
os.makedirs(OUT, exist_ok=True)
random.seed(7)
Q = D("0.01")


def money(x):
    return D(x).quantize(Q, rounding=ROUND_HALF_UP)


def us(x):
    return f"{money(x):,.2f}"


def eu(x):
    return f"{money(x):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


class Inv:
    def __init__(self, number, date_iso, supplier, customer, items, tax_rate=None, tax_override=None,
                 currency="USD", total_override=None, has_tax=True):
        self.number, self.date_iso, self.supplier, self.customer = number, date_iso, supplier, customer
        self.items = [(d, D(q), money(p), money(D(q) * money(p))) for d, q, p in items]
        self.subtotal = money(sum(i[3] for i in self.items))
        if not has_tax:
            self.tax = None
        elif tax_override is not None:
            self.tax = money(tax_override)
        else:
            self.tax = money(self.subtotal * D(str(tax_rate)))
        base = self.subtotal + (self.tax or D(0))
        self.total = money(total_override) if total_override is not None else money(base)
        self.currency = currency

    def truth(self, status="valid", file_type="pdf", corrupt=False, desc=""):
        return {
            "filename": None, "file_type": file_type, "is_corrupt": corrupt,
            "ground_truth": {
                "invoice_number": self.number, "invoice_date": self.date_iso, "supplier_name": self.supplier,
                "customer_name": self.customer, "subtotal": float(self.subtotal),
                "tax": None if self.tax is None else float(self.tax), "total": float(self.total),
                "currency": self.currency, "line_items_count": len(self.items)},
            "expected_validation_status": status, "description": desc}


GT = []


def register(filename, truth):
    truth["filename"] = filename
    truth["id"] = f"V2-{len(GT) + 1:03d}"
    GT.append(truth)


def new_pdf(name, compress=1):
    return canvas.Canvas(os.path.join(OUT, name), pagesize=A4, pageCompression=compress)


def put(c, x, y, text, size=11, bold=False):
    c.setFont("Helvetica-Bold" if bold else "Helvetica", size)
    c.drawString(x, y, text)


# --------------------------------------------------------------------------------------------- PDFs
def pdf_standard(name, inv, labels, fmt=us, sym="", date_txt=None, extra=None, tax_label="Tax", tail_code=True,
                 show_tax=True, show_customer=True, desc=""):
    c = new_pdf(name)
    y = 790
    put(c, 50, y, labels.get("title", "INVOICE"), 18, True); y -= 30
    for line in (extra or {}).get("header", []):
        put(c, 50, y, line, 9); y -= 13
    put(c, 50, y, f"{labels['num']}: {inv.number}"); y -= 16
    put(c, 50, y, f"{labels['date']}: {date_txt or inv.date_iso}"); y -= 16
    for line in (extra or {}).get("after_date", []):
        put(c, 50, y, line); y -= 16
    put(c, 50, y, f"{labels['sup']}: {inv.supplier}"); y -= 16
    if show_customer:
        put(c, 50, y, f"{labels['cus']}: {inv.customer}"); y -= 16
    y -= 10
    put(c, 50, y, "Description          Qty      Unit price      Amount", 10, True); y -= 16
    for d, q, p, a in inv.items:
        put(c, 50, y, f"{d}     {q}     {sym}{fmt(p)}     {sym}{fmt(a)}"); y -= 15
    y -= 10
    put(c, 300, y, f"{labels['sub']}: {sym}{fmt(inv.subtotal)}"); y -= 16
    if show_tax and inv.tax is not None:
        put(c, 300, y, f"{tax_label}: {sym}{fmt(inv.tax)}"); y -= 16
    code = f" {inv.currency}" if tail_code else ""
    put(c, 300, y, f"{labels['tot']}: {sym}{fmt(inv.total)}{code}", 12, True)
    c.showPage()
    c.save()
    return inv


EN = dict(num="Invoice No", date="Date", sup="Supplier", cus="Customer", sub="Subtotal", tot="Total")

# D01 baseline
d01 = Inv("INV-2026-101", "2026-04-02", "Harborview Marine Supplies Inc", "Lakeside Boating Club",
          [("Rope 3/8in", 4, "12.50"), ("Fender", 2, "35.00")], "0.08")
pdf_standard("D01_standard_us.pdf", d01, EN)
register("D01_standard_us.pdf", d01.truth(desc="Baseline US-style digital PDF"))

# D02 different labels, long date, pound sign, no currency code
d02 = Inv("2026/0457", "2026-04-14", "Kestrel Office Furniture Ltd", "Brightpath Accounting",
          [("Standing desk", 1, "450.00"), ("Task chair", 2, "120.00")], "0.20", currency="GBP")
pdf_standard("D02_labels_gbp.pdf", d02, dict(title="SALES INVOICE", num="Invoice #", date="Invoice Date", sup="Vendor",
                                              cus="Sold To", sub="Net", tot="Amount due"),
             sym="£", date_txt="14 April 2026", tax_label="VAT (20%)", tail_code=False)
register("D02_labels_gbp.pdf", d02.truth(desc="Different labels, long-form date, GBP shown only as a pound sign"))

# D03 German layout, EU numbers and dd.mm.yyyy
d03 = Inv("RE-88231", "2026-05-03", "Nordlicht Werkzeuge GmbH", "Baumeister Schulz AG",
          [("Bohrer", 10, "25.00"), ("Schrauben-Set", 5, "150.00")], "0.19", currency="EUR")
c = new_pdf("D03_german_eur.pdf")
put(c, 50, 790, "RECHNUNG", 18, True)
put(c, 50, 760, f"Rechnungsnummer: {d03.number}")
put(c, 50, 744, "Datum: 03.05.2026")
put(c, 50, 728, f"Lieferant: {d03.supplier}")
put(c, 50, 712, f"Kunde: {d03.customer}")
y = 680
for d, q, p, a in d03.items:
    put(c, 50, y, f"{d}   {q}   {eu(p)} €   {eu(a)} €"); y -= 15
put(c, 300, y - 10, f"Zwischensumme: {eu(d03.subtotal)} €")
put(c, 300, y - 26, f"MwSt 19%: {eu(d03.tax)} €")
put(c, 300, y - 44, f"Gesamtbetrag: {eu(d03.total)} €", 12, True)
c.showPage(); c.save()
register("D03_german_eur.pdf", d03.truth(desc="German labels, dd.mm.yyyy date, European number format, EUR symbol"))

# D04 Bangladesh BDT, dd/mm/yyyy (unambiguous day 21)
d04 = Inv("DHK-2026-0912", "2026-04-21", "Padma Textile Mills Ltd", "Dhaka Garments Export Co",
          [("Cotton fabric (m)", 500, "250.00"), ("Dyeing service", 1, "40000.00")], "0.15", currency="BDT")
pdf_standard("D04_bdt.pdf", d04, EN, date_txt="21/04/2026", tax_label="VAT 15%", tail_code=False,
             sym="BDT ")
register("D04_bdt.pdf", d04.truth(desc="BDT amounts with a currency prefix, dd/mm/yyyy date"))

# D05 missing customer
d05 = Inv("INV-2026-205", "2026-05-10", "Greenfield Organics LLC", None, [("Compost 40lb", 30, "9.75")], "0.07")
pdf_standard("D05_no_customer.pdf", d05, EN, show_customer=False)
register("D05_no_customer.pdf", d05.truth("needs_review", desc="No customer/bill-to on the invoice; must be null, not invented"))

# D06 tax-free invoice (no tax line)
d06 = Inv("TF-0099", "2026-05-11", "Riverstone Consulting", "Cobalt Startups", [("Consulting (hours)", 10, "150.00")],
          has_tax=False)
pdf_standard("D06_tax_free.pdf", d06, dict(EN, num="Invoice Number"), show_tax=False)
register("D06_tax_free.pdf", d06.truth(desc="Tax-free invoice: no tax line, so tax must be null; subtotal equals total"))

# D07 arithmetic error printed on the invoice
d07 = Inv("INV-2026-307", "2026-05-20", "Summit Lab Equipment Co", "Pinecrest Clinic", [("Centrifuge tubes", 10, "10.00")],
          tax_override="10.00", total_override="115.00")
pdf_standard("D07_math_error.pdf", d07, EN)
register("D07_math_error.pdf", d07.truth("invalid", desc="Printed total (115.00) does not equal subtotal + tax (110.00)"))

# D08 multi-page, 10 lines, totals on page 2
amounts = ["120.00", "80.00", "45.50", "60.00", "99.99", "200.00", "35.00", "15.25", "72.40", "310.10"]
d08 = Inv("INV-2026-410", "2026-06-01", "Atlas Industrial Parts Co", "Foundry Works Ltd",
          [(f"Part {chr(65 + i)}-{100 + i}", 1, a) for i, a in enumerate(amounts)], "0.08")
c = new_pdf("D08_multipage.pdf")
put(c, 50, 790, "INVOICE", 18, True); put(c, 450, 790, "Page 1 of 2", 9)
put(c, 50, 760, f"Invoice No: {d08.number}"); put(c, 50, 744, f"Date: {d08.date_iso}")
put(c, 50, 728, f"Supplier: {d08.supplier}"); put(c, 50, 712, f"Customer: {d08.customer}")
y = 680
for d, q, p, a in d08.items[:6]:
    put(c, 50, y, f"{d}   {q}   {us(p)}   {us(a)}"); y -= 15
put(c, 50, 60, "Continued on next page", 9); c.showPage()
put(c, 450, 790, "Page 2 of 2", 9); put(c, 50, 790, f"Invoice No: {d08.number} (continued)", 9)
y = 740
for d, q, p, a in d08.items[6:]:
    put(c, 50, y, f"{d}   {q}   {us(p)}   {us(a)}"); y -= 15
put(c, 300, y - 20, f"Subtotal: {us(d08.subtotal)}"); put(c, 300, y - 36, f"Tax: {us(d08.tax)}")
put(c, 300, y - 54, f"Total: {us(d08.total)} USD", 12, True)
c.showPage(); c.save()
register("D08_multipage.pdf", d08.truth(desc="Two-page invoice; line items split across pages; totals on page 2"))

# D09 table layout: every cell is a separate text object (like most real generators)
d09 = Inv("INV-2026-512", "2026-06-08", "Bluebird Print Studio", "Harlow & Finch Attorneys",
          [("Business cards", 500, "0.12"), ("Letterhead", 250, "0.40"), ("Banner", 2, "65.00"),
           ("Flyers", 1000, "0.08"), ("Design fee", 1, "120.00")], "0.0825")
c = new_pdf("D09_table_layout.pdf")
put(c, 50, 790, "INVOICE", 18, True)
for k, (lbl, val) in enumerate([("Invoice No:", d09.number), ("Date:", d09.date_iso), ("Supplier:", d09.supplier),
                                ("Customer:", d09.customer)]):
    put(c, 50, 760 - 16 * k, lbl, 11, True); put(c, 140, 760 - 16 * k, val)
y = 680
for x, h in zip((50, 260, 320, 420), ("Description", "Qty", "Unit price", "Amount")):
    put(c, x, y, h, 10, True)
for d, q, p, a in d09.items:
    y -= 16
    for x, v in zip((50, 260, 320, 420), (d, str(q), us(p), us(a))):
        put(c, x, y, v)
put(c, 320, y - 30, "Subtotal", 11); put(c, 420, y - 30, us(d09.subtotal))
put(c, 320, y - 46, "Tax (8.25%)", 11); put(c, 420, y - 46, us(d09.tax))
put(c, 320, y - 64, "Total", 12, True); put(c, 420, y - 64, us(d09.total), 12, True); put(c, 480, y - 64, "USD", 12)
c.showPage(); c.save()
register("D09_table_layout.pdf", d09.truth(desc="Table layout where each cell is its own text object"))

# D10 "Bill" wording, no INV prefix
d10 = Inv("B-7781", "2026-06-01", "Maple Street Bakery", "City Cafe Network",
          [("Sourdough loaf", 40, "4.50"), ("Croissant", 60, "2.25"), ("Baguette", 30, "3.10")], "0.05")
pdf_standard("D10_bill_wording.pdf", d10, dict(title="BILL", num="Bill No", date="Bill Date", sup="From", cus="To",
                                               sub="Subtotal", tot="Total"))
register("D10_bill_wording.pdf", d10.truth(desc="'Bill' wording (Bill No / From / To), identifier without an INV prefix"))

# D11 exact duplicate of D01 (different file)
c = new_pdf("D11_duplicate_of_D01.pdf")
c.showPage(); c.save()
pdf_standard("D11_duplicate_of_D01.pdf", d01, EN)
register("D11_duplicate_of_D01.pdf", d01.truth("needs_review", desc="Same supplier and invoice number as D01: must be flagged as a duplicate"))

# D12 plain numeric invoice number, US-style long date
d12 = Inv("4471", "2026-06-15", "Ocean Freight Partners Co", "Delta Imports", [("Container handling", 3, "850.00")], "0.00",
          has_tax=True)
pdf_standard("D12_numeric_number.pdf", d12, dict(EN, num="Invoice no."), date_txt="Jun 15, 2026")
register("D12_numeric_number.pdf", d12.truth(desc="Purely numeric invoice number, 'Jun 15, 2026' date, zero tax printed"))

# D13 distractors: due date, PO number, phone, VAT id, payment terms
d13 = Inv("INV-2026-618", "2026-06-15", "Crescent Logistics Group", "Aurora Retail Partners",
          [("Pallet storage", 12, "18.00"), ("Handling fee", 1, "75.00")], "0.10")
pdf_standard("D13_distractors.pdf", d13, EN,
             extra=dict(header=["Crescent Logistics Group | 400 Harbour Rd, Unit 12 | Tel: +1 555 0142 | VAT ID: 99-2014-776",
                                "Payment terms: Net 30"],
                        after_date=["Due date: 2026-07-15", "PO number: PO-5521", "Order ref: 2026-0098"]))
register("D13_distractors.pdf", d13.truth(desc="Due date, PO number, phone and VAT ids near the real fields"))

# --------------------------------------------------------------------------------------------- CSV
def write(name, text, enc="utf-8"):
    with open(os.path.join(OUT, name), "w", encoding=enc, newline="") as f:
        f.write(text)


c1 = Inv("INV-2026-701", "2026-07-01", "Tidewater Chemicals Inc", "Orchard Farms LLC",
         [("Fertilizer 50lb", 20, "18.00"), ("Soil test kit", 5, "40.00")], "0.08")
write("C01_keyvalue.csv", "\n".join([
    f"Invoice Number,{c1.number}", f"Invoice Date,{c1.date_iso}", f"Supplier,{c1.supplier}", f"Customer,{c1.customer}",
    f"Currency,{c1.currency}", "Item,Qty,Unit Price,Amount",
    *[f"{d},{q},{p},{a}" for d, q, p, a in c1.items],
    f"Subtotal,,,{c1.subtotal}", f"Tax,,,{c1.tax}", f"Total,,,{c1.total}"]) + "\n")
register("C01_keyvalue.csv", c1.truth(file_type="csv", desc="Key/value CSV with an item table and totals rows"))

c2 = Inv("INV-2026-702", "2026-07-02", "Falcon Roofing Supply", "Ridgeview Homes",
         [("Shingles bundle", 100, "32.00")], "0.06")
write("C02_single_row.csv", "invoice_number,invoice_date,supplier,customer,subtotal,tax,total,currency\n"
      f"{c2.number},{c2.date_iso},{c2.supplier},{c2.customer},{c2.subtotal},{c2.tax},{c2.total},{c2.currency}\n")
t = c2.truth(file_type="csv", desc="One-row CSV with a header row; no line items")
t["ground_truth"]["line_items_count"] = 0
register("C02_single_row.csv", t)

c3 = Inv("RE-9001", "2026-07-03", "Rheintal Maschinenbau GmbH", "Alpenblick Hotels AG",
         [("Wartung", 2, "600.00"), ("Ersatzteil", 4, "37.50")], "0.19", currency="EUR")
write("C03_semicolon_eu.csv", "\n".join([
    f"Rechnungsnummer;{c3.number}", f"Datum;{c3.date_iso}", f"Lieferant;{c3.supplier}", f"Kunde;{c3.customer}",
    f"Waehrung;{c3.currency}", "Position;Menge;Einzelpreis;Betrag",
    *[f"{d};{q};{eu(p)};{eu(a)}" for d, q, p, a in c3.items],
    f"Zwischensumme;;;{eu(c3.subtotal)}", f"MwSt;;;{eu(c3.tax)}", f"Gesamt;;;{eu(c3.total)}"]) + "\n")
register("C03_semicolon_eu.csv", c3.truth(file_type="csv", desc="Semicolon CSV, German labels, decimal commas"))

# --------------------------------------------------------------------------------------------- XLSX
x1 = Inv("INV-2026-801", "2026-07-10", "Copperline Electrical Supply", "Westbank Apartments",
         [("Cable 100m", 6, "54.00"), ("Breaker 20A", 12, "9.50")], "0.07")
wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Invoice"
ws.append(["INVOICE"]); ws.append(["Invoice No", x1.number]); ws.append(["Date", x1.date_iso])
ws.append(["Supplier", x1.supplier]); ws.append(["Customer", x1.customer]); ws.append(["Currency", x1.currency]); ws.append([])
ws.append(["Item", "Qty", "Unit Price", "Amount"])
for d, q, p, a in x1.items:
    ws.append([d, int(q), float(p), float(a)])
ws.append(["Subtotal", None, None, float(x1.subtotal)]); ws.append(["Tax", None, None, float(x1.tax)])
ws.append(["Total", None, None, float(x1.total)])
wb.save(os.path.join(OUT, "X01_single_sheet.xlsx"))
register("X01_single_sheet.xlsx", x1.truth(file_type="xlsx", desc="Single-sheet workbook, label/value header block + item table"))

x2 = Inv("INV-2026-802", "2026-07-11", "Driftwood Furniture Co", "Seaside Cafe",
         [("Oak table", 3, "280.00"), ("Chair", 12, "45.00")], "0.09")
wb = openpyxl.Workbook(); h = wb.active; h.title = "Header"
for row in (["Invoice No", x2.number], ["Date", x2.date_iso], ["Supplier", x2.supplier], ["Customer", x2.customer],
            ["Currency", x2.currency], ["Subtotal", float(x2.subtotal)], ["Tax", float(x2.tax)], ["Total", float(x2.total)]):
    h.append(row)
it = wb.create_sheet("Items"); it.append(["Item", "Qty", "Unit Price", "Amount"])
for d, q, p, a in x2.items:
    it.append([d, int(q), float(p), float(a)])
wb.save(os.path.join(OUT, "X02_two_sheets.xlsx"))
register("X02_two_sheets.xlsx", x2.truth(file_type="xlsx", desc="Header and Items on separate sheets"))

x3 = Inv("INV-2026-803", "2026-07-12", "Granite Peak Outfitters", "Basecamp Rentals",
         [("Tent 4p", 5, "199.00"), ("Stove", 5, "49.00"), ("Lantern", 10, "14.00")], "0.06")
wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Sheet1"
ws.merge_cells("A1:D1"); ws["A1"] = "GRANITE PEAK OUTFITTERS: TAX INVOICE"
ws.append([]); ws.append(["Invoice Number:", x3.number, "Invoice Date:", x3.date_iso])
ws.append(["Supplier:", x3.supplier, "Customer:", x3.customer]); ws.append(["Currency:", x3.currency]); ws.append([])
ws.append(["Description", "Qty", "Price", "Line total"])
for d, q, p, a in x3.items:
    ws.append([d, int(q), float(p), float(a)])
ws.append([]); ws.append(["", "", "Subtotal", float(x3.subtotal)]); ws.append(["", "", "Tax", float(x3.tax)])
ws.append(["", "", "Total", float(x3.total)])
wb.save(os.path.join(OUT, "X03_merged_title.xlsx"))
register("X03_merged_title.xlsx", x3.truth(file_type="xlsx", desc="Merged title cell, header values side by side"))

# --------------------------------------------------------------------------------------------- images / scanned
def font(size):
    for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/Library/Fonts/Arial.ttf", "C:/Windows/Fonts/arial.ttf"):
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def render(inv, size=(1240, 1500), fs=30):
    im = Image.new("RGB", size, "white"); dr = ImageDraw.Draw(im); f = font(fs); y = 80
    lines = ["INVOICE", f"Invoice No: {inv.number}", f"Date: {inv.date_iso}", f"Supplier: {inv.supplier}",
             f"Customer: {inv.customer}", ""]
    lines += [f"{d}   {q}   {us(p)}   {us(a)}" for d, q, p, a in inv.items]
    lines += ["", f"Subtotal: {us(inv.subtotal)}", f"Tax: {us(inv.tax)}", f"Total: {us(inv.total)} {inv.currency}"]
    for ln in lines:
        dr.text((80, y), ln, fill="black", font=f); y += fs + 22
    return im


def degrade(im, angle, noise, blur):
    im = im.rotate(angle, expand=True, fillcolor="white").filter(ImageFilter.GaussianBlur(blur))
    px = im.load()
    for _ in range(int(im.width * im.height * noise)):
        px[random.randrange(im.width), random.randrange(im.height)] = (random.randrange(256),) * 3
    return im


i1 = Inv("INV-2026-901", "2026-08-01", "Lighthouse Paper Co", "Evergreen Publishing", [("Paper ream", 40, "6.50"), ("Toner", 3, "89.00")], "0.07")
render(i1).save(os.path.join(OUT, "I01_clean.png"))
register("I01_clean.png", i1.truth(file_type="image", desc="Clean rendered invoice image (needs OCR)"))
i2 = Inv("INV-2026-902", "2026-08-02", "Quarry Stone Works", "Hillcrest Landscaping", [("Granite slab", 4, "310.00"), ("Delivery", 1, "95.00")], "0.08")
degrade(render(i2), 3.0, 0.01, 1.1).save(os.path.join(OUT, "I02_skewed_noisy.png"))
register("I02_skewed_noisy.png", i2.truth(file_type="image", desc="3 degree skew, noise and blur (needs OCR)"))
i3 = Inv("INV-2026-903", "2026-08-03", "Tanager Electronics", "Kestrel Labs", [("Sensor board", 25, "14.40")], "0.05")
render(i3, size=(620, 760), fs=15).convert("L").save(os.path.join(OUT, "I03_low_res.jpg"), quality=35)
register("I03_low_res.jpg", i3.truth(file_type="image", desc="Low resolution, heavy JPEG compression (needs OCR)"))

s1 = Inv("INV-2026-951", "2026-08-10", "Orchid Bay Seafood", "Marina Grill Group", [("Prawns 5kg", 12, "48.00"), ("Squid 5kg", 8, "31.00")], "0.07")
render(s1).save(os.path.join(OUT, "S01_scanned.pdf"), "PDF", resolution=150)
register("S01_scanned.pdf", s1.truth(file_type="scanned_pdf", desc="Image-only PDF (no text layer): needs OCR"))
s2 = Inv("INV-2026-952", "2026-08-11", "Silverline Fabrication", "Northgate Builders", [("Steel plate", 6, "142.00")], "0.08")
degrade(render(s2), -2.0, 0.008, 0.9).save(os.path.join(OUT, "S02_scanned_skewed.pdf"), "PDF", resolution=150)
register("S02_scanned_skewed.pdf", s2.truth(file_type="scanned_pdf", desc="Skewed image-only PDF: needs OCR"))

# --------------------------------------------------------------------------------------------- corrupted
good = open(os.path.join(OUT, "D01_standard_us.pdf"), "rb").read()
open(os.path.join(OUT, "K01_truncated.pdf"), "wb").write(good[: int(len(good) * 0.55)])
open(os.path.join(OUT, "K02_random_bytes.pdf"), "wb").write(os.urandom(4096))
open(os.path.join(OUT, "K03_empty.pdf"), "wb").write(b"")
for fn, desc in (("K01_truncated.pdf", "PDF cut off at 55%: no %%EOF"), ("K02_random_bytes.pdf", "Random bytes with a .pdf extension"),
                 ("K03_empty.pdf", "Zero-byte file")):
    t = d01.truth("failed", "pdf", True, desc)
    t["ground_truth"] = {k: None for k in t["ground_truth"]}
    register(fn, t)

with open(os.path.join(HERE, "ground_truth_independent.json"), "w", encoding="utf-8") as f:
    json.dump(GT, f, indent=2, ensure_ascii=False)
print(f"wrote {len(GT)} documents to {OUT}")
by = {}
for g in GT:
    by[g["file_type"]] = by.get(g["file_type"], 0) + 1
print("by type:", by)
