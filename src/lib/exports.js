// Shared report-export helpers for the admin panel (Phase 4 reporting layer).
// One callsite per resource picks columns + fetches the full table; this module
// turns that into either a styled .xlsx or a paginated landscape PDF and pipes
// it to the response.
//
// Why a shared helper rather than per-route generators:
//   - Column metadata becomes the single source of truth for both formats —
//     header label, width, value formatter — so the two outputs can never drift.
//   - PDF table layout (pagination, header repeat, footer, INR formatting) is
//     fiddly enough that rewriting it 8 times would guarantee bugs.
//
// Column shape: { key, header, width?, format? }
//   format ∈ 'currency' | 'date' | 'datetime' | 'number' | 'boolean' | 'text' (default)
//   width  ∈ characters (xlsx) and is also used to weight the PDF column.

import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

const FMT_CURRENCY_XLSX = '"₹"#,##0.00';
const FMT_DATE_XLSX = 'yyyy-mm-dd';
const FMT_DATETIME_XLSX = 'yyyy-mm-dd hh:mm';

// PDF prints "Rs." rather than the rupee glyph because pdfkit's default
// Helvetica family doesn't include U+20B9 — embedding a fallback font just
// for one symbol isn't worth the bundle weight.
const fmtPdf = {
  currency: (v) => (v == null || v === '' ? '' : `Rs. ${Number(v).toFixed(2)}`),
  date:     (v) => (v ? new Date(v).toISOString().slice(0, 10) : ''),
  datetime: (v) => (v ? new Date(v).toISOString().slice(0, 16).replace('T', ' ') : ''),
  number:   (v) => (v == null || v === '' ? '' : String(Number(v))),
  boolean:  (v) => (v === true ? 'Yes' : v === false ? 'No' : ''),
  text:     (v) => (v == null ? '' : Array.isArray(v) ? v.join(', ') : String(v)),
};

const safeFilename = (s) => String(s || 'report').replace(/[^A-Za-z0-9_.-]+/g, '_');

// ---------------------------------------------------------------
// Excel
// ---------------------------------------------------------------
export async function sendXlsx(res, { sheetName = 'Report', columns, rows, filename, title, summary }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Redlook Admin';
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName.slice(0, 31)); // Excel caps sheet names at 31 chars

  let cursor = 1;

  // Optional title block above the table — stays out of the data region so
  // pivots / filters on the table aren't polluted.
  if (title) {
    ws.mergeCells(cursor, 1, cursor, Math.max(1, columns.length));
    const cell = ws.getCell(cursor, 1);
    cell.value = title;
    cell.font = { size: 14, bold: true, color: { argb: 'FF065F46' } }; // emerald-800
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    cursor += 1;
  }

  if (summary && Array.isArray(summary) && summary.length) {
    for (const { label, value } of summary) {
      ws.getCell(cursor, 1).value = label;
      ws.getCell(cursor, 1).font = { bold: true, color: { argb: 'FF6B7280' } };
      ws.getCell(cursor, 2).value = value;
      cursor += 1;
    }
    cursor += 1; // blank gutter
  }

  // ExcelJS column definitions drive both the header row and column widths.
  // We assign columns first, then push the actual header at `cursor` so the
  // optional title block above doesn't clash with auto header generation.
  ws.columns = columns.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.width || Math.max(12, (c.header || '').length + 2),
  }));

  // Move the header row to `cursor`, then we add data after it. ExcelJS doesn't
  // expose "header row index" directly, so we write the header manually here.
  const headerRow = ws.getRow(cursor);
  columns.forEach((c, i) => { headerRow.getCell(i + 1).value = c.header; });
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF059669' } }; // emerald-600
  headerRow.alignment = { vertical: 'middle', horizontal: 'left' };
  headerRow.height = 22;
  cursor += 1;

  // Data rows — apply per-column number formats so currency/date columns
  // look right when the user opens the workbook in Excel/Numbers/Sheets.
  for (const row of rows) {
    const r = ws.getRow(cursor);
    columns.forEach((c, i) => {
      const cell = r.getCell(i + 1);
      const raw = row[c.key];
      switch (c.format) {
        case 'currency':
          cell.value = raw == null || raw === '' ? null : Number(raw);
          cell.numFmt = FMT_CURRENCY_XLSX;
          break;
        case 'date':
          cell.value = raw ? new Date(raw) : null;
          cell.numFmt = FMT_DATE_XLSX;
          break;
        case 'datetime':
          cell.value = raw ? new Date(raw) : null;
          cell.numFmt = FMT_DATETIME_XLSX;
          break;
        case 'number':
          cell.value = raw == null || raw === '' ? null : Number(raw);
          break;
        case 'boolean':
          cell.value = raw === true ? 'Yes' : raw === false ? 'No' : '';
          break;
        default:
          // Arrays are rendered as joined strings (e.g. permissions[]).
          cell.value = Array.isArray(raw) ? raw.join(', ') : (raw == null ? '' : raw);
      }
    });
    cursor += 1;
  }

  // Freeze the header row so the table is navigable on scroll.
  ws.views = [{ state: 'frozen', ySplit: cursor - rows.length - 1 }];

  // AutoFilter on the data range — gives the recipient one-click sort/filter.
  if (rows.length > 0) {
    ws.autoFilter = {
      from: { row: cursor - rows.length - 1, column: 1 },
      to:   { row: cursor - 1, column: columns.length },
    };
  }

  const buffer = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(filename)}.xlsx"`);
  res.setHeader('Content-Length', buffer.length);
  res.end(Buffer.from(buffer));
}

// ---------------------------------------------------------------
// PDF — landscape A4 table with auto-pagination
// ---------------------------------------------------------------
export function sendPdf(res, { columns, rows, filename, title, subtitle, summary, orientation = 'landscape' }) {
  return new Promise((resolve, reject) => {
    // bufferPages keeps every page in memory until doc.end(), which is required
    // for the page-number footer below — switchToPage on a flushed page no-ops.
    const doc = new PDFDocument({ size: 'A4', layout: orientation, margin: 32, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => {
      const buf = Buffer.concat(chunks);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(filename)}.pdf"`);
      res.setHeader('Content-Length', buf.length);
      res.end(buf);
      resolve();
    });
    doc.on('error', reject);

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const left = doc.page.margins.left;

    // Distribute width by column.width (characters) — falls back to header
    // length when a column doesn't declare a width.
    const weights = columns.map((c) => c.width || Math.max(8, (c.header || '').length + 2));
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    const colXs = [];
    const colWs = [];
    let x = left;
    weights.forEach((w) => {
      const cw = (w / totalWeight) * pageWidth;
      colXs.push(x);
      colWs.push(cw);
      x += cw;
    });

    const ROW_H = 18;
    const HEADER_H = 22;

    // ---- Header (page 1 + every continuation page) ----
    let y;
    const drawTitleBlock = () => {
      let cy = doc.page.margins.top;
      doc.font('Helvetica-Bold').fontSize(14).fillColor('#065F46').text(title || 'Report', left, cy);
      cy = doc.y;
      if (subtitle) {
        doc.font('Helvetica').fontSize(9).fillColor('#6B7280').text(subtitle, left, cy);
        cy = doc.y;
      }
      if (Array.isArray(summary) && summary.length) {
        // Comma-separated single line: "Total: 42  ·  Generated: 2026-05-10 14:32"
        const parts = summary.map((s) => `${s.label}: ${s.value}`);
        doc.font('Helvetica').fontSize(9).fillColor('#374151')
          .text(parts.join('   ·   '), left, cy + 2);
        cy = doc.y;
      }
      doc.fillColor('#000');
      return cy + 8;
    };

    const drawTableHeader = (startY) => {
      doc.rect(left, startY, pageWidth, HEADER_H).fill('#059669').stroke();
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(9);
      columns.forEach((c, i) => {
        doc.text(c.header, colXs[i] + 4, startY + 7, {
          width: colWs[i] - 8,
          height: HEADER_H - 8,
          ellipsis: true,
        });
      });
      doc.fillColor('#000');
      return startY + HEADER_H;
    };

    y = drawTitleBlock();
    y = drawTableHeader(y);

    // ---- Body rows with auto-pagination ----
    doc.font('Helvetica').fontSize(9);
    const bottom = doc.page.height - doc.page.margins.bottom - ROW_H;

    for (let idx = 0; idx < rows.length; idx++) {
      if (y > bottom) {
        doc.addPage();
        y = drawTitleBlock();
        y = drawTableHeader(y);
        doc.font('Helvetica').fontSize(9);
      }

      // Zebra stripe for readability.
      if (idx % 2 === 1) {
        doc.rect(left, y, pageWidth, ROW_H).fill('#F3F4F6');
        doc.fillColor('#000');
      }
      doc.rect(left, y, pageWidth, ROW_H).strokeColor('#E5E7EB').stroke();
      doc.strokeColor('#000');

      const row = rows[idx];
      columns.forEach((c, i) => {
        const formatter = fmtPdf[c.format] || fmtPdf.text;
        const text = formatter(row[c.key]);
        const align = ['currency', 'number'].includes(c.format) ? 'right' : 'left';
        doc.fillColor('#111').text(text, colXs[i] + 4, y + 5, {
          width: colWs[i] - 8,
          height: ROW_H - 4,
          ellipsis: true,
          align,
        });
      });

      y += ROW_H;
    }

    // Empty-state message when there are no rows — better than a blank page.
    if (rows.length === 0) {
      doc.font('Helvetica-Oblique').fontSize(10).fillColor('#6B7280')
        .text('No records to export.', left, y + 12);
    }

    // Footer with page numbers — written after the body so we know how
    // many pages the document spans. Range API was added to pdfkit 0.13.
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const footY = doc.page.height - doc.page.margins.bottom + 8;
      doc.font('Helvetica').fontSize(8).fillColor('#6B7280')
        .text(
          `Page ${i + 1} of ${range.count}   ·   Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
          left,
          footY,
          { width: pageWidth, align: 'center' },
        );
    }

    doc.end();
  });
}

// ---------------------------------------------------------------
// KPI-flavoured PDF — used by the Reports tab where the payload is a set of
// summary cards + several small tables, not one big table. Rendered as a
// single A4 portrait page (or two) with a header and stacked sections.
// ---------------------------------------------------------------
export function sendKpiPdf(res, { filename, title, subtitle, sections }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => {
      const buf = Buffer.concat(chunks);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(filename)}.pdf"`);
      res.setHeader('Content-Length', buf.length);
      res.end(buf);
      resolve();
    });
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    doc.font('Helvetica-Bold').fontSize(16).fillColor('#065F46').text(title, left);
    if (subtitle) {
      doc.moveDown(0.2);
      doc.font('Helvetica').fontSize(9).fillColor('#6B7280').text(subtitle, left);
    }
    doc.moveDown(0.6);

    for (const section of sections) {
      // Soft page break when we're close to the bottom — KPI sections don't
      // wrap mid-table, so push to the next page if there isn't headroom.
      if (doc.y > doc.page.height - doc.page.margins.bottom - 100) {
        doc.addPage();
      }

      doc.font('Helvetica-Bold').fontSize(11).fillColor('#111')
        .text(section.heading, left, doc.y, { underline: false });
      doc.moveDown(0.3);

      if (section.kind === 'kpi-grid') {
        // 3-column grid of KPI cards
        const cellW = pageWidth / 3 - 6;
        const cellH = 50;
        const startY = doc.y;
        section.items.forEach((it, i) => {
          const col = i % 3;
          const row = Math.floor(i / 3);
          const cx = left + col * (cellW + 8);
          const cy = startY + row * (cellH + 6);
          doc.rect(cx, cy, cellW, cellH).fill('#F0FDF4').stroke('#A7F3D0');
          doc.fillColor('#065F46').font('Helvetica').fontSize(8).text(it.label, cx + 8, cy + 6, { width: cellW - 16 });
          doc.fillColor('#111').font('Helvetica-Bold').fontSize(13).text(it.value, cx + 8, cy + 22, { width: cellW - 16 });
        });
        const rowsCount = Math.ceil(section.items.length / 3);
        doc.y = startY + rowsCount * (cellH + 6) + 6;
      } else if (section.kind === 'table') {
        // Compact table within KPI report — same column shape, tighter rows.
        const cols = section.columns;
        const weights = cols.map((c) => c.width || Math.max(8, (c.header || '').length + 2));
        const totalWeight = weights.reduce((s, w) => s + w, 0);
        let x = left;
        const xs = [];
        const ws = [];
        weights.forEach((w) => { const cw = (w / totalWeight) * pageWidth; xs.push(x); ws.push(cw); x += cw; });

        const HEADER_H = 18, ROW_H = 16;
        let y = doc.y;
        doc.rect(left, y, pageWidth, HEADER_H).fill('#059669');
        doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8.5);
        cols.forEach((c, i) => doc.text(c.header, xs[i] + 4, y + 5, { width: ws[i] - 8, ellipsis: true }));
        y += HEADER_H;
        doc.fillColor('#111').font('Helvetica').fontSize(8.5);

        for (let idx = 0; idx < section.rows.length; idx++) {
          if (y > doc.page.height - doc.page.margins.bottom - ROW_H) {
            doc.addPage();
            y = doc.page.margins.top;
          }
          if (idx % 2 === 1) {
            doc.rect(left, y, pageWidth, ROW_H).fill('#F3F4F6');
            doc.fillColor('#111');
          }
          const r = section.rows[idx];
          cols.forEach((c, i) => {
            const formatter = fmtPdf[c.format] || fmtPdf.text;
            const text = formatter(r[c.key]);
            const align = ['currency', 'number'].includes(c.format) ? 'right' : 'left';
            doc.text(text, xs[i] + 4, y + 4, { width: ws[i] - 8, ellipsis: true, align });
          });
          y += ROW_H;
        }
        doc.y = y + 6;
      }

      doc.moveDown(0.4);
    }

    // Footer with page numbers
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const footY = doc.page.height - doc.page.margins.bottom + 8;
      doc.font('Helvetica').fontSize(8).fillColor('#6B7280').text(
        `Page ${i + 1} of ${range.count}   ·   Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
        left, footY, { width: pageWidth, align: 'center' },
      );
    }

    doc.end();
  });
}

// ---------------------------------------------------------------
// KPI helpers — used by the Reports export to render a multi-section .xlsx.
// Each section becomes its own worksheet so admins can pivot independently.
// ---------------------------------------------------------------
export async function sendKpiXlsx(res, { filename, title, subtitle, sections }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Redlook Admin';
  wb.created = new Date();

  // Cover sheet — title + KPI grid items combined.
  const cover = wb.addWorksheet('Summary');
  cover.getCell('A1').value = title;
  cover.getCell('A1').font = { size: 14, bold: true, color: { argb: 'FF065F46' } };
  cover.mergeCells('A1:D1');
  if (subtitle) {
    cover.getCell('A2').value = subtitle;
    cover.getCell('A2').font = { color: { argb: 'FF6B7280' } };
    cover.mergeCells('A2:D2');
  }
  cover.getColumn(1).width = 32;
  cover.getColumn(2).width = 22;

  let cy = 4;
  for (const section of sections.filter((s) => s.kind === 'kpi-grid')) {
    cover.getCell(cy, 1).value = section.heading;
    cover.getCell(cy, 1).font = { bold: true };
    cy += 1;
    for (const it of section.items) {
      cover.getCell(cy, 1).value = it.label;
      cover.getCell(cy, 2).value = it.value;
      cy += 1;
    }
    cy += 1;
  }

  // Each table section -> dedicated sheet.
  for (const section of sections.filter((s) => s.kind === 'table')) {
    const ws = wb.addWorksheet(section.heading.slice(0, 31));
    ws.columns = section.columns.map((c) => ({
      header: c.header,
      key: c.key,
      width: c.width || Math.max(12, (c.header || '').length + 2),
    }));
    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF059669' } };
    for (const r of section.rows) {
      const out = {};
      for (const c of section.columns) {
        let v = r[c.key];
        if (c.format === 'currency' || c.format === 'number') v = v == null || v === '' ? null : Number(v);
        if (c.format === 'date' || c.format === 'datetime') v = v ? new Date(v) : null;
        out[c.key] = v;
      }
      const row = ws.addRow(out);
      section.columns.forEach((c, i) => {
        const cell = row.getCell(i + 1);
        if (c.format === 'currency') cell.numFmt = FMT_CURRENCY_XLSX;
        else if (c.format === 'date') cell.numFmt = FMT_DATE_XLSX;
        else if (c.format === 'datetime') cell.numFmt = FMT_DATETIME_XLSX;
      });
    }
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    if (section.rows.length > 0) {
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: section.rows.length + 1, column: section.columns.length } };
    }
  }

  const buffer = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(filename)}.xlsx"`);
  res.setHeader('Content-Length', buffer.length);
  res.end(Buffer.from(buffer));
}

// ---------------------------------------------------------------
// Tiny dispatcher — route handlers usually accept ?format=xlsx|pdf.
// ---------------------------------------------------------------
export function pickFormat(query) {
  const f = String(query?.format || '').toLowerCase();
  if (f === 'xlsx' || f === 'excel') return 'xlsx';
  if (f === 'pdf') return 'pdf';
  return null;
}
