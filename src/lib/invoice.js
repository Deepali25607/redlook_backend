// Generates a tax invoice PDF for an Order (BRD FR-PAY-07).
// Returns a Promise<Buffer>. Uses pdfkit so it stays pure-Node — no headless Chrome.
//
// Notes on tax:
//   The Order row stores a single `tax` figure computed at 5% of (subtotal - discount).
//   For a domestic B2C retail invoice that's split equally as CGST 2.5% + SGST 2.5%.
//   Several fresh vegetables are GST-exempt in practice (HSN 0701–0714); when a real
//   HSN/GST master is wired in, replace TAX_HSN + the split logic below.

import PDFDocument from 'pdfkit';

// Fallbacks when BusinessSettings hasn't been configured yet (or the
// admin cleared a field). The route layer passes the live settings row
// in via `seller`; we merge over these so the PDF never renders blanks.
const SELLER_FALLBACK = {
  name: 'Redlook',
  address: '',
  gstin: '',
  email: '',
  phone: '',
};

// Build the seller block from a BusinessSettings row. Splits the free-form
// address text on newlines so each line prints on its own row in the PDF
// without us having to enforce a structured address shape.
function buildSeller(settings) {
  if (!settings) return { ...SELLER_FALLBACK, addressLines: [] };
  const addressLines = (settings.company_address || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    name: settings.company_name || SELLER_FALLBACK.name,
    addressLines,
    email: settings.support_email || '',
    phone: settings.support_phone || '',
    // gstin is not yet a settings field; leave blank until/unless added.
    gstin: '',
  };
}

// Default HSN for fresh vegetables — used until a per-product HSN exists.
const TAX_HSN = '0709';

const fmt = (n) => `Rs. ${Number(n).toFixed(2)}`;

// Indian number-to-words (Lakh/Crore system) — invoices in India typically print
// "Amount in Words". Keep it simple: integer rupees only, paise rounded.
function rupeesInWords(amount) {
  const n = Math.round(Number(amount));
  if (n === 0) return 'Zero Rupees Only';
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  const twoDigits = (num) => {
    if (num < 20) return ones[num];
    return tens[Math.floor(num / 10)] + (num % 10 ? ' ' + ones[num % 10] : '');
  };
  const threeDigits = (num) => {
    const h = Math.floor(num / 100);
    const r = num % 100;
    return (h ? ones[h] + ' Hundred' + (r ? ' ' : '') : '') + (r ? twoDigits(r) : '');
  };

  let result = '';
  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const rest = n % 1000;

  if (crore) result += threeDigits(crore) + ' Crore ';
  if (lakh) result += twoDigits(lakh) + ' Lakh ';
  if (thousand) result += twoDigits(thousand) + ' Thousand ';
  if (rest) result += threeDigits(rest);
  return result.trim() + ' Rupees Only';
}

export function generateInvoicePDF(order, customer, settings = null) {
  const SELLER = buildSeller(settings);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const taxableValue = Number(order.subtotal) - Number(order.discount);
    const cgst = Number(order.tax) / 2;
    const sgst = Number(order.tax) / 2;

    // ---- Header ----
    doc.fontSize(18).font('Helvetica-Bold').text('TAX INVOICE', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').fillColor('#555')
      .text('Original for recipient', { align: 'center' });
    doc.fillColor('#000');
    doc.moveDown(1);

    // ---- Seller / Buyer two-column block ----
    const colTop = doc.y;
    const colWidth = 250;

    // Seller (left) — every line is conditional so an admin who's left a
    // settings field blank doesn't end up with a "GSTIN: " or "  ·  "
    // ghost line on the printed invoice.
    doc.font('Helvetica-Bold').fontSize(11).text(SELLER.name, 40, colTop);
    doc.font('Helvetica').fontSize(9);
    SELLER.addressLines.forEach((line) => doc.text(line));
    if (SELLER.gstin) doc.text(`GSTIN: ${SELLER.gstin}`);
    const contactBits = [SELLER.email, SELLER.phone].filter(Boolean);
    if (contactBits.length) doc.text(contactBits.join('  ·  '));

    // Buyer (right) — uses snapshot from order so historical invoices are stable
    const addr = order.address;
    doc.font('Helvetica-Bold').fontSize(10).text('Bill / Ship To', 305, colTop);
    doc.font('Helvetica-Bold').fontSize(11).text(addr.recipient_name);
    doc.font('Helvetica').fontSize(9)
      .text(addr.address_line1)
      .text([addr.address_line2, addr.landmark].filter(Boolean).join(', ') || ' ')
      .text(`${addr.city}, ${addr.state} - ${addr.pincode}`)
      .text(`Phone: ${addr.recipient_phone}`)
      .text(`Email: ${customer.email}`);

    // Pull cursor below whichever column went lower
    doc.y = Math.max(doc.y, colTop + 90);
    doc.moveDown(1);

    // ---- Invoice metadata ----
    const metaY = doc.y;
    doc.font('Helvetica-Bold').fontSize(9).text('Invoice No:', 40, metaY)
      .font('Helvetica').text(order.order_id, 110, metaY);
    doc.font('Helvetica-Bold').text('Invoice Date:', 305, metaY)
      .font('Helvetica').text(new Date(order.order_date).toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
      }), 380, metaY);

    doc.moveDown(0.5);
    const meta2Y = doc.y;
    doc.font('Helvetica-Bold').text('Place of Supply:', 40, meta2Y)
      .font('Helvetica').text(`${addr.state}`, 130, meta2Y);
    doc.font('Helvetica-Bold').text('Payment:', 305, meta2Y)
      .font('Helvetica').text(`${order.payment_method} (${order.payment_status})`, 360, meta2Y);

    doc.moveDown(1.5);

    // Sum of MRP-vs-paid savings across all lines. Distinct from
    // `order.discount` (the coupon discount on subtotal) — both can be
    // present, both shown separately so the customer sees the full
    // breakdown of how the final total was reached.
    const productSavings = (order.items || []).reduce((s, it) => {
      const mrp = Number(it.mrp ?? 0);
      const paid = Number(it.price ?? 0);
      const qty = Number(it.qty ?? 0);
      return s + (mrp > paid ? (mrp - paid) * qty : 0);
    }, 0);
    const showMrp = productSavings > 0;

    // ---- Items table ----
    // When any line carries an MRP-vs-paid gap we render an MRP column to
    // show savings per line; otherwise we keep the original layout so
    // legacy invoices stay visually identical.
    const tableTop = doc.y;
    const cols = showMrp ? {
      sno:  { x: 40,  w: 25,  label: '#' },
      item: { x: 70,  w: 175, label: 'Item' },
      hsn:  { x: 250, w: 40,  label: 'HSN' },
      qty:  { x: 295, w: 45,  label: 'Qty' },
      mrp:  { x: 345, w: 60,  label: 'MRP' },
      rate: { x: 410, w: 60,  label: 'Rate' },
      amt:  { x: 475, w: 80,  label: 'Amount' },
    } : {
      sno:  { x: 40,  w: 25,  label: '#' },
      item: { x: 70,  w: 200, label: 'Item' },
      hsn:  { x: 275, w: 50,  label: 'HSN' },
      qty:  { x: 330, w: 50,  label: 'Qty' },
      rate: { x: 385, w: 75,  label: 'Rate' },
      amt:  { x: 465, w: 90,  label: 'Amount' },
    };

    // Header row
    doc.rect(40, tableTop, 515, 22).fill('#f0f0f0').stroke();
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(9);
    Object.entries(cols).forEach(([key, c]) => {
      const align = ['qty', 'mrp', 'rate', 'amt'].includes(key) ? 'right' : 'left';
      doc.text(c.label, c.x + 4, tableTop + 7, { width: c.w - 8, align });
    });

    // Body rows
    let rowY = tableTop + 22;
    doc.font('Helvetica').fontSize(9);
    order.items.forEach((it, idx) => {
      const rowH = 20;
      doc.rect(40, rowY, 515, rowH).stroke('#ddd');
      doc.fillColor('#000');
      doc.text(String(idx + 1), cols.sno.x + 4, rowY + 6, { width: cols.sno.w - 8 });
      doc.text(it.name, cols.item.x + 4, rowY + 6, { width: cols.item.w - 8 });
      doc.text(TAX_HSN, cols.hsn.x + 4, rowY + 6, { width: cols.hsn.w - 8 });
      doc.text(`${Number(it.qty)} ${it.unit}`, cols.qty.x + 4, rowY + 6, { width: cols.qty.w - 8, align: 'right' });
      // MRP column: render the strikethrough by drawing a line over the
      // text after writing it. Only when this specific line was actually
      // marked down — otherwise leave the column blank so the customer's
      // eye is drawn to the lines that did save them money.
      if (showMrp) {
        const lineMrp = Number(it.mrp ?? 0);
        const linePaid = Number(it.price ?? 0);
        if (lineMrp > linePaid) {
          const mrpText = fmt(lineMrp);
          doc.fillColor('#666');
          doc.text(mrpText, cols.mrp.x + 4, rowY + 6, { width: cols.mrp.w - 8, align: 'right' });
          const textWidth = doc.widthOfString(mrpText);
          const strikeX = cols.mrp.x + 4 + (cols.mrp.w - 8) - textWidth;
          const strikeY = rowY + 6 + 4;
          doc.moveTo(strikeX, strikeY).lineTo(strikeX + textWidth, strikeY).stroke('#888');
          doc.fillColor('#000');
        } else {
          doc.text('-', cols.mrp.x + 4, rowY + 6, { width: cols.mrp.w - 8, align: 'right' });
        }
      }
      doc.text(fmt(it.price), cols.rate.x + 4, rowY + 6, { width: cols.rate.w - 8, align: 'right' });
      doc.text(fmt(Number(it.price) * Number(it.qty)), cols.amt.x + 4, rowY + 6, { width: cols.amt.w - 8, align: 'right' });
      rowY += rowH;
    });

    // ---- Totals box (right-aligned) ----
    let totalsY = rowY + 10;
    const labelX = 360;
    const valueX = 465;
    const valueW = 90;

    const totalRow = (label, value, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
      doc.text(label, labelX, totalsY, { width: 100, align: 'right' });
      doc.text(value, valueX, totalsY, { width: valueW, align: 'right' });
      totalsY += 14;
    };

    // When products were discounted, surface the "Item Total (MRP)" so the
    // customer can trace the math: MRP total → minus product savings →
    // equals Subtotal. Subtotal itself is already the post-discount sum
    // (line price × qty). Order matters: MRP first, then savings, then
    // subtotal so the columns line up the way they read.
    if (showMrp) {
      const mrpTotal = Number(order.subtotal) + productSavings;
      totalRow('Item Total (MRP)', fmt(mrpTotal));
      totalRow('Product Savings', `- ${fmt(productSavings)}`);
    }
    totalRow('Subtotal', fmt(order.subtotal));
    if (Number(order.discount) > 0) totalRow('Coupon Discount', `- ${fmt(order.discount)}`);
    // GST lines are only rendered when tax was actually charged. Fresh vegetables
    // are GST-exempt today, but invoices issued during the brief 5% window stay
    // intact — historical orders still print their original CGST/SGST split.
    if (Number(order.tax) > 0) {
      totalRow('Taxable Value', fmt(taxableValue));
      totalRow('CGST @ 2.5%', fmt(cgst));
      totalRow('SGST @ 2.5%', fmt(sgst));
    }
    totalRow('Delivery Charge', fmt(order.delivery_charge));
    totalsY += 4;
    doc.moveTo(labelX, totalsY).lineTo(valueX + valueW, totalsY).stroke();
    totalsY += 6;
    totalRow('Grand Total', fmt(order.total_amount), true);

    // ---- "You saved" callout ----
    // Aggregate of product-level (MRP-vs-paid) plus coupon-level savings,
    // shown only when there's something to celebrate. Drawn as a green
    // pill spanning the totals column so it stands out without dominating
    // the page.
    const totalSaved = productSavings + Number(order.discount || 0);
    if (totalSaved > 0) {
      totalsY += 6;
      doc.rect(labelX - 10, totalsY, (valueX + valueW) - (labelX - 10), 22)
        .fillAndStroke('#e8f5e9', '#43a047');
      doc.fillColor('#1b5e20').font('Helvetica-Bold').fontSize(10)
        .text(`You saved ${fmt(totalSaved)} on this order`, labelX - 6, totalsY + 6, {
          width: (valueX + valueW) - (labelX - 6),
          align: 'center',
        });
      doc.fillColor('#000');
      totalsY += 26;
    }

    // ---- Amount in words ----
    doc.moveDown(2);
    doc.font('Helvetica-Bold').fontSize(9).text('Amount in Words: ', 40, totalsY + 12, { continued: true });
    doc.font('Helvetica').text(rupeesInWords(order.total_amount));

    // ---- Footer ----
    doc.moveDown(2);
    doc.font('Helvetica-Oblique').fontSize(8).fillColor('#666')
      .text('This is a computer-generated invoice and does not require a signature.', 40, doc.y, { align: 'center', width: 515 });
    doc.moveDown(0.3);
    // Footer contact line — same conditional treatment as the seller block
    // above so empty admin fields don't leak into the printed invoice.
    const queryBits = [
      SELLER.email && `contact ${SELLER.email}`,
      SELLER.phone && `call ${SELLER.phone}`,
    ].filter(Boolean);
    if (queryBits.length) {
      doc.text(`For queries, ${queryBits.join(' or ')}.`, { align: 'center', width: 515 });
    }

    doc.end();
  });
}
