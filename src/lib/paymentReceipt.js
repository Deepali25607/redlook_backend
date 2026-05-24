// Generates a payment-receipt PDF for a PaymentReceived row (BRD §7).
// Returns a Promise<Buffer>. Mirrors lib/invoice.js — same pdfkit pipeline,
// same seller-block construction from BusinessSettings, same currency
// helpers — so a recipient holding both an invoice and a receipt sees the
// same brand voice on both documents.
//
// The receipt differs from a Tax Invoice in two ways:
//   1. It records money received, not goods sold; no GST split is required.
//   2. A single payment can be allocated across multiple invoices (FIFO),
//      so the body is an "applied-to" table listing each DEBIT touched
//      with the amount applied to it.

import PDFDocument from 'pdfkit';

const SELLER_FALLBACK = {
  name: 'Redlook',
  address: '',
  email: '',
  phone: '',
};

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
  };
}

const fmt = (n) => `Rs. ${Number(n).toFixed(2)}`;

// Same Lakh/Crore words helper as invoice.js — duplicated rather than
// extracted because both files are otherwise self-contained and the
// helper is small. If a third doc starts using it, lift it into a shared
// module.
function rupeesInWords(amount) {
  const n = Math.round(Number(amount));
  if (n === 0) return 'Zero Rupees Only';
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const twoDigits = (num) => num < 20 ? ones[num] : tens[Math.floor(num / 10)] + (num % 10 ? ' ' + ones[num % 10] : '');
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

// `payment` — a PaymentReceived row (raw Prisma record is fine; we read
//   amount, payment_date, mode, reference_no, applied_to_invoice_ids).
// `customer` — the Customer row (full_name, email, phone, business_name).
// `allocations` — pre-resolved [{ credit_transaction, applied_amount }]
//   where credit_transaction is the matching CreditTransaction row (so
//   the receipt shows order_id + due_date + amount per invoice line).
// `settings` — BusinessSettings row for the seller block.
export function generatePaymentReceiptPDF({ payment, customer, allocations, settings = null }) {
  const SELLER = buildSeller(settings);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ---- Header ----
    doc.fontSize(18).font('Helvetica-Bold').text('PAYMENT RECEIPT', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').fillColor('#555')
      .text('Acknowledgement of payment received', { align: 'center' });
    doc.fillColor('#000');
    doc.moveDown(1);

    // ---- Seller / Buyer two-column block ----
    const colTop = doc.y;

    doc.font('Helvetica-Bold').fontSize(11).text(SELLER.name, 40, colTop);
    doc.font('Helvetica').fontSize(9);
    SELLER.addressLines.forEach((line) => doc.text(line));
    const contactBits = [SELLER.email, SELLER.phone].filter(Boolean);
    if (contactBits.length) doc.text(contactBits.join('  ·  '));

    doc.font('Helvetica-Bold').fontSize(10).text('Received From', 305, colTop);
    doc.font('Helvetica-Bold').fontSize(11).text(
      customer.business_name || customer.full_name || 'Customer', 305,
    );
    doc.font('Helvetica').fontSize(9);
    if (customer.business_name && customer.full_name) doc.text(customer.full_name, 305);
    if (customer.email) doc.text(customer.email, 305);
    if (customer.phone) doc.text(`Phone: ${customer.phone}`, 305);
    if (customer.gstin) doc.text(`GSTIN: ${customer.gstin}`, 305);

    // Pull cursor below whichever column went lower
    doc.y = Math.max(doc.y, colTop + 90);
    doc.moveDown(1);

    // ---- Receipt metadata ----
    const metaY = doc.y;
    doc.font('Helvetica-Bold').fontSize(9).text('Receipt No:', 40, metaY)
      .font('Helvetica').text(payment.id.slice(0, 18).toUpperCase(), 110, metaY);
    doc.font('Helvetica-Bold').text('Receipt Date:', 305, metaY)
      .font('Helvetica').text(new Date(payment.payment_date).toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
      }), 380, metaY);

    doc.moveDown(0.5);
    const meta2Y = doc.y;
    doc.font('Helvetica-Bold').text('Payment Mode:', 40, meta2Y)
      .font('Helvetica').text(payment.mode.replace('_', ' '), 130, meta2Y);
    if (payment.reference_no) {
      doc.font('Helvetica-Bold').text('Reference:', 305, meta2Y)
        .font('Helvetica').text(payment.reference_no, 360, meta2Y);
    }

    doc.moveDown(1.5);

    // ---- Allocation table ("Applied to invoices") ----
    const tableTop = doc.y;
    const cols = {
      sno:    { x: 40,  w: 25,  label: '#' },
      ref:    { x: 70,  w: 165, label: 'Invoice / Order' },
      due:    { x: 240, w: 75,  label: 'Due Date' },
      total:  { x: 320, w: 75,  label: 'Invoice Amt' },
      paid:   { x: 400, w: 75,  label: 'Applied' },
      bal:    { x: 480, w: 75,  label: 'Balance' },
    };

    // Header row
    doc.rect(40, tableTop, 515, 22).fill('#f0f0f0').stroke();
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(9);
    Object.entries(cols).forEach(([key, c]) => {
      const align = ['total', 'paid', 'bal'].includes(key) ? 'right' : 'left';
      doc.text(c.label, c.x + 4, tableTop + 7, { width: c.w - 8, align });
    });

    let rowY = tableTop + 22;
    doc.font('Helvetica').fontSize(9);

    if (!allocations || allocations.length === 0) {
      // No allocations recorded — payment may have been an unallocated
      // advance. Show a single placeholder row.
      const rowH = 20;
      doc.rect(40, rowY, 515, rowH).stroke('#ddd');
      doc.text('1', cols.sno.x + 4, rowY + 6);
      doc.text('Unallocated advance', cols.ref.x + 4, rowY + 6, { width: cols.ref.w - 8 });
      doc.text('—', cols.due.x + 4, rowY + 6, { width: cols.due.w - 8 });
      doc.text('—', cols.total.x + 4, rowY + 6, { width: cols.total.w - 8, align: 'right' });
      doc.text(fmt(payment.amount), cols.paid.x + 4, rowY + 6, { width: cols.paid.w - 8, align: 'right' });
      doc.text('—', cols.bal.x + 4, rowY + 6, { width: cols.bal.w - 8, align: 'right' });
      rowY += rowH;
    } else {
      allocations.forEach((alloc, idx) => {
        const tx = alloc.credit_transaction;
        const rowH = 20;
        doc.rect(40, rowY, 515, rowH).stroke('#ddd');
        doc.fillColor('#000');
        doc.text(String(idx + 1), cols.sno.x + 4, rowY + 6, { width: cols.sno.w - 8 });
        // Order id is the most recognisable handle for the customer; fall
        // back to a short transaction id when the DEBIT had no order
        // (manual ADJUSTMENT-derived debits, opening balances, etc.).
        const ref = tx?.order_id || (tx?.id ? tx.id.slice(0, 12) : '—');
        doc.text(ref, cols.ref.x + 4, rowY + 6, { width: cols.ref.w - 8 });
        const due = tx?.due_date
          ? new Date(tx.due_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
          : '—';
        doc.text(due, cols.due.x + 4, rowY + 6, { width: cols.due.w - 8 });
        doc.text(tx ? fmt(tx.amount) : '—', cols.total.x + 4, rowY + 6, { width: cols.total.w - 8, align: 'right' });
        doc.text(fmt(alloc.applied_amount), cols.paid.x + 4, rowY + 6, { width: cols.paid.w - 8, align: 'right' });
        // Remaining balance after this allocation lands.
        const balance = tx ? Math.max(0, Number(tx.amount) - Number(tx.amount_paid)) : 0;
        doc.text(tx ? fmt(balance) : '—', cols.bal.x + 4, rowY + 6, { width: cols.bal.w - 8, align: 'right' });
        rowY += rowH;
      });
    }

    // ---- Totals box ----
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

    totalsY += 4;
    doc.moveTo(labelX, totalsY).lineTo(valueX + valueW, totalsY).stroke();
    totalsY += 6;
    totalRow('Total Received', fmt(payment.amount), true);

    // ---- Amount in words ----
    doc.font('Helvetica-Bold').fontSize(9).text('Amount in Words: ', 40, totalsY + 12, { continued: true });
    doc.font('Helvetica').text(rupeesInWords(payment.amount));

    // Optional notes line — only when set, so a blank "Notes:" doesn't
    // dangle on the printed receipt.
    if (payment.notes) {
      doc.moveDown(0.6);
      doc.font('Helvetica-Bold').fontSize(9).text('Notes: ', 40, doc.y, { continued: true });
      doc.font('Helvetica').text(payment.notes);
    }

    // ---- Footer ----
    doc.moveDown(2);
    doc.font('Helvetica-Oblique').fontSize(8).fillColor('#666')
      .text('This is a computer-generated receipt and does not require a signature.', 40, doc.y, { align: 'center', width: 515 });
    doc.moveDown(0.3);
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
