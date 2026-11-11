import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { calculateRealizedGrossMargin } from "@/lib/pricing";
import { formatDate, formatDateTime, formatQty, toLocalDateString } from "@/lib/utils";
import type {
  AdminProduct,
  AgencySettings,
  Category,
  CustomerAddress,
  CustomerProfile,
  InvoiceRecord,
  Manufacturer,
  OrderItemFinancialRecord,
  OrderItemRecord,
  OrderRecord,
  PaymentRecord,
  PurchaseOrderItemRecord,
  PurchaseOrderRecord,
} from "@/types/database";

const MARGIN_X = 32;
const TOP_NEXT_PAGE_Y = 42;
const BOTTOM_FOOTER_RESERVE = 38;
const LANDSCAPE_TABLE_W = 777;
const PORTRAIT_TABLE_W = 531;

/**
 * Sanitizes arbitrary text into Helvetica/WinAnsi-safe characters so symbols
 * like Indian Rupee (₹) or Unicode arrows/dashes never render as garbled Latin-1 bytes.
 */
export function pdfText(value: unknown, fallback = "-"): string {
  if (value === null || value === undefined) return fallback;
  const raw = String(value).trim();
  if (!raw) return fallback;
  return raw
    .replace(/\u20b9/g, "Rs. ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2022/g, "|")
    .replace(/\u2026/g, "...")
    .replace(/\u2192/g, "->")
    .replace(/\u2264/g, "<=")
    .replace(/\u2265/g, ">=")
    .replace(/\u00a0/g, " ")
    // Preserve printable ASCII + printable Latin-1 (e.g. \u00d7 multiplication sign in "10×12") + newlines
    .replace(/[^\x09\x0a\x20-\x7e\xa1-\xff]/g, "");
}

function formatPdfMoney(value: number | string | null | undefined, symbol = "₹"): string {
  const num = Number(value ?? 0);
  const safePrefix = symbol === "₹" ? "Rs. " : `${pdfText(symbol, "")} `;
  if (!Number.isFinite(num)) return `${safePrefix}0.00`;
  const sign = num < 0 ? "-" : "";
  return `${sign}${safePrefix}${Math.abs(num).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatPdfSignedMoney(value: number | string | null | undefined, symbol = "₹"): string {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num) || num === 0) return formatPdfMoney(0, symbol);
  return num > 0 ? `+${formatPdfMoney(num, symbol)}` : formatPdfMoney(num, symbol);
}

function getLastTableEndY(doc: jsPDF, fallbackY: number): number {
  return (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? fallbackY;
}

function ensureSpace(doc: jsPDF, curY: number, neededHeight: number): number {
  const pageHeight = doc.internal.pageSize.getHeight();
  if (curY + neededHeight > pageHeight - BOTTOM_FOOTER_RESERVE) {
    doc.addPage();
    return TOP_NEXT_PAGE_Y;
  }
  return curY;
}

function formatStatusLabel(status: string | null | undefined): string {
  if (!status) return "-";
  return pdfText(
    status
      .replace(/_/g, " ")
      .replace(/\b\w/g, (m) => m.toUpperCase())
  );
}

function drawDocumentHeader(
  doc: jsPDF,
  params: {
    agency: AgencySettings;
    title: string;
    subtitle?: string;
    rightMeta?: string[];
  }
): number {
  const { agency, title, subtitle, rightMeta = [] } = params;
  const pageWidth = doc.internal.pageSize.getWidth();
  const headerH = 74;

  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, pageWidth, headerH, "F");

  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text(pdfText(agency.legal_name || agency.agency_name || "Agency Operations"), MARGIN_X, 26);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  const agencyMeta = [
    agency.gstin ? `GSTIN: ${agency.gstin}` : null,
    agency.pan ? `PAN: ${agency.pan}` : null,
    agency.phone ? `Tel: ${agency.phone}` : null,
    agency.email ? `Email: ${agency.email}` : null,
  ]
    .filter(Boolean)
    .join("   |   ");
  if (agencyMeta) {
    doc.text(pdfText(agencyMeta), MARGIN_X, 41, { maxWidth: pageWidth * 0.56 });
  }
  const addrLine = [agency.address, agency.city, agency.state, agency.pincode].filter(Boolean).join(", ");
  if (addrLine) {
    doc.text(pdfText(addrLine), MARGIN_X, 55, { maxWidth: pageWidth * 0.56 });
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.text(pdfText(title), pageWidth - MARGIN_X, 27, { align: "right" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  if (subtitle) {
    doc.text(pdfText(subtitle), pageWidth - MARGIN_X, 42, { align: "right", maxWidth: pageWidth * 0.38 });
  }
  const metaLine = rightMeta.length > 0 ? rightMeta.join("  |  ") : `Generated: ${formatDateTime(new Date().toISOString())}`;
  doc.setTextColor(203, 213, 225);
  doc.setFontSize(8);
  doc.text(pdfText(metaLine), pageWidth - MARGIN_X, 56, { align: "right" });

  doc.setTextColor(15, 23, 42);
  return headerH + 18;
}

interface KpiBox {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "green" | "red" | "amber" | "blue";
}

function drawKpiStrip(doc: jsPDF, startY: number, cards: KpiBox[]): number {
  const y = ensureSpace(doc, startY, 54);
  const pageWidth = doc.internal.pageSize.getWidth();
  const usableW = pageWidth - MARGIN_X * 2;
  const gap = 8;
  const cardW = (usableW - gap * (cards.length - 1)) / cards.length;
  const cardH = 44;

  cards.forEach((card, idx) => {
    const x = MARGIN_X + idx * (cardW + gap);
    doc.setDrawColor(226, 232, 240);
    doc.setFillColor(248, 250, 252);
    doc.roundedRect(x, y, cardW, cardH, 3, 3, "FD");

    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.2);
    doc.setTextColor(100, 116, 139);
    doc.text(pdfText(card.label.toUpperCase()), x + 8, y + 13, { maxWidth: cardW - 16 });

    if (card.tone === "green") doc.setTextColor(4, 120, 87);
    else if (card.tone === "red") doc.setTextColor(185, 28, 28);
    else if (card.tone === "amber") doc.setTextColor(180, 83, 9);
    else if (card.tone === "blue") doc.setTextColor(29, 78, 216);
    else doc.setTextColor(15, 23, 42);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text(pdfText(card.value), x + 8, y + 28, { maxWidth: cardW - 16 });

    if (card.sub) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7);
      doc.setTextColor(100, 116, 139);
      doc.text(pdfText(card.sub), x + 8, y + 39, { maxWidth: cardW - 16 });
    }
  });

  doc.setTextColor(15, 23, 42);
  return y + cardH + 14;
}

function drawSectionHeading(doc: jsPDF, curY: number, heading: string, caption?: string): number {
  const needed = caption ? 42 : 28;
  const y = ensureSpace(doc, curY, needed);
  const pageWidth = doc.internal.pageSize.getWidth();

  doc.setDrawColor(30, 64, 175);
  doc.setFillColor(30, 64, 175);
  doc.rect(MARGIN_X, y - 9, 3, 13, "F");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(15, 23, 42);
  doc.text(pdfText(heading), MARGIN_X + 9, y);

  if (caption) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text(pdfText(caption), MARGIN_X + 9, y + 12, { maxWidth: pageWidth - MARGIN_X * 2 - 10 });
    doc.setTextColor(15, 23, 42);
    return y + 20;
  }

  doc.setDrawColor(226, 232, 240);
  doc.line(MARGIN_X, y + 5, pageWidth - MARGIN_X, y + 5);
  return y + 12;
}

function drawMutedNote(doc: jsPDF, curY: number, text: string): number {
  const y = ensureSpace(doc, curY, 26);
  const pageWidth = doc.internal.pageSize.getWidth();
  doc.setDrawColor(226, 232, 240);
  doc.setFillColor(248, 250, 252);
  doc.roundedRect(MARGIN_X, y, pageWidth - MARGIN_X * 2, 22, 3, 3, "FD");
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.2);
  doc.setTextColor(100, 116, 139);
  doc.text(pdfText(text), MARGIN_X + 10, y + 14);
  doc.setTextColor(15, 23, 42);
  return y + 32;
}

function addPageFooters(doc: jsPDF, footerLeft: string): void {
  const totalPages = doc.getNumberOfPages();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setDrawColor(226, 232, 240);
    doc.line(MARGIN_X, pageHeight - 28, pageWidth - MARGIN_X, pageHeight - 28);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(100, 116, 139);
    doc.text(pdfText(footerLeft), MARGIN_X, pageHeight - 16, { maxWidth: pageWidth - 150 });
    doc.text(`Page ${i} of ${totalPages}`, pageWidth - MARGIN_X, pageHeight - 16, { align: "right" });
  }
  doc.setTextColor(15, 23, 42);
}

// ============================================================================
// EXISTING TRANSACTION DOCUMENTS (PO & CUSTOMER INVOICE)
// ============================================================================

export function generatePurchaseOrderPdf(params: {
  agency: AgencySettings;
  po: PurchaseOrderRecord;
  manufacturer: Manufacturer;
  items: PurchaseOrderItemRecord[];
  sourceOrderNumber?: string | null;
}): void {
  const { agency, po, manufacturer, items, sourceOrderNumber } = params;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const sym = agency.currency_symbol || "₹";

  // Top Header Band
  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, 595, 78, "F");

  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(pdfText(agency.legal_name || agency.agency_name), 40, 32);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  const agencyMeta = [
    agency.gstin ? `GSTIN: ${agency.gstin}` : null,
    agency.pan ? `PAN: ${agency.pan}` : null,
    agency.phone ? `Tel: ${agency.phone}` : null,
  ]
    .filter(Boolean)
    .join("   |   ");
  if (agencyMeta) doc.text(pdfText(agencyMeta), 40, 48);
  const addrLine = [agency.address, agency.city, agency.state, agency.pincode].filter(Boolean).join(", ");
  if (addrLine) doc.text(pdfText(addrLine), 40, 62, { maxWidth: 340 });

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("PURCHASE ORDER", 555, 36, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(pdfText(po.po_number), 555, 54, { align: "right" });

  // Supplier + PO Meta Columns
  doc.setTextColor(15, 23, 42);
  let y = 104;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text("TO MANUFACTURER / SUPPLIER", 40, y);
  doc.text("PURCHASE ORDER DETAILS", 340, y);

  y += 16;
  doc.setTextColor(15, 23, 42);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text(pdfText(manufacturer.company_name), 40, y);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  const mfgLines = [
    `Attn: ${manufacturer.contact_person} (${manufacturer.phone})`,
    manufacturer.email ? `Email: ${manufacturer.email}` : null,
    manufacturer.gst_number ? `GSTIN: ${manufacturer.gst_number}` : null,
    [manufacturer.address, manufacturer.city, manufacturer.state].filter(Boolean).join(", "),
  ]
    .filter(Boolean)
    .map((line) => pdfText(line));
  doc.text(mfgLines, 40, y + 15, { maxWidth: 270 });

  const poMetaRows = [
    ["PO Number:", pdfText(po.po_number)],
    ["Issue Date:", pdfText(formatDate(po.created_at))],
    ["Status:", pdfText(po.status)],
    ["Expected Delivery:", po.expected_delivery_date ? pdfText(formatDate(po.expected_delivery_date)) : "As per schedule"],
    ["Internal Order Ref:", pdfText(sourceOrderNumber || "Stock Replenishment")],
  ];

  poMetaRows.forEach(([k, v], idx) => {
    const rowY = y + idx * 15;
    doc.setFont("helvetica", "bold");
    doc.text(k, 340, rowY);
    doc.setFont("helvetica", "normal");
    doc.text(v, 445, rowY);
  });

  // Items Table
  autoTable(doc, {
    startY: 205,
    head: [["#", "Product & SKU", "Unit", "Qty", "Mfg Unit Price", "GST %", "GST Amt", "Line Total"]],
    body: items.map((item, index) => [
      String(index + 1),
      `${pdfText(item.product_name_snapshot)}\nSKU: ${pdfText(item.sku_snapshot)}`,
      pdfText(item.unit_snapshot),
      formatQty(item.quantity),
      formatPdfMoney(item.unit_manufacturer_price, sym),
      `${item.gst_rate}%`,
      formatPdfMoney(item.tax_amount, sym),
      formatPdfMoney(item.line_total, sym),
    ]),
    styles: { fontSize: 8.5, cellPadding: 6, textColor: [15, 23, 42] },
    headStyles: { fillColor: [30, 64, 175], textColor: [255, 255, 255], fontStyle: "bold" },
    columnStyles: {
      0: { cellWidth: 26, halign: "center" },
      3: { halign: "right" },
      4: { halign: "right" },
      5: { halign: "right" },
      6: { halign: "right" },
      7: { halign: "right", fontStyle: "bold" },
    },
    margin: { left: 40, right: 40 },
  });

  const finalY = getLastTableEndY(doc, 360);
  let summaryY = finalY + 22;

  if (summaryY > 700) {
    doc.addPage();
    summaryY = 50;
  }

  // Totals Box
  doc.setDrawColor(203, 213, 225);
  doc.setFillColor(248, 250, 252);
  doc.roundedRect(335, summaryY, 220, 74, 4, 4, "FD");

  doc.setFontSize(9.5);
  doc.setFont("helvetica", "normal");
  doc.text("Taxable Subtotal:", 350, summaryY + 20);
  doc.text(formatPdfMoney(po.subtotal, sym), 542, summaryY + 20, { align: "right" });

  doc.text("Total GST:", 350, summaryY + 38);
  doc.text(formatPdfMoney(po.tax_total, sym), 542, summaryY + 38, { align: "right" });

  doc.setDrawColor(203, 213, 225);
  doc.line(350, summaryY + 48, 542, summaryY + 48);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Grand Total:", 350, summaryY + 64);
  doc.text(formatPdfMoney(po.total_amount, sym), 542, summaryY + 64, { align: "right" });

  if (po.notes) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.text("Notes & Instructions:", 40, summaryY + 14);
    doc.setFont("helvetica", "normal");
    doc.text(pdfText(po.notes), 40, summaryY + 28, { maxWidth: 275 });
  }

  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139);
  doc.text(
    pdfText(
      `Authorized Purchase Document issued by ${agency.agency_name}. Please reference ${po.po_number} on all challans & invoices.`
    ),
    40,
    800
  );

  doc.save(`${pdfText(po.po_number, "PO")}.pdf`);
}

export function generateCustomerInvoicePdf(params: {
  agency: AgencySettings;
  invoice: InvoiceRecord;
  customer: CustomerProfile;
  order: OrderRecord;
  items: OrderItemRecord[];
  payments?: PaymentRecord[];
}): void {
  const { agency, invoice, customer, order, items, payments = [] } = params;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const sym = agency.currency_symbol || "₹";

  // Header
  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, 595, 82, "F");

  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(pdfText(agency.legal_name || agency.agency_name), 40, 30);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  const taxIds = [
    agency.gstin ? `GSTIN: ${agency.gstin}` : null,
    agency.pan ? `PAN: ${agency.pan}` : null,
    agency.email ? `Email: ${agency.email}` : null,
  ]
    .filter(Boolean)
    .join("   |   ");
  if (taxIds) doc.text(pdfText(taxIds), 40, 46);
  const fullAgencyAddr = [agency.address, agency.city, agency.state, agency.pincode, agency.phone ? `Tel: ${agency.phone}` : null]
    .filter(Boolean)
    .join(", ");
  if (fullAgencyAddr) doc.text(pdfText(fullAgencyAddr), 40, 60, { maxWidth: 345 });

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("TAX INVOICE", 555, 34, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(pdfText(invoice.invoice_number), 555, 52, { align: "right" });
  doc.setFontSize(8.5);
  doc.text(invoice.is_inter_state ? "Supply Type: Inter-State (IGST)" : "Supply Type: Intra-State (CGST + SGST)", 555, 66, {
    align: "right",
  });

  // Bill To / Ship To / Meta
  let y = 104;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.5);
  doc.setTextColor(100, 116, 139);
  doc.text("BILL TO", 40, y);
  doc.text("SHIP TO", 220, y);
  doc.text("INVOICE DETAILS", 400, y);

  y += 14;
  doc.setTextColor(15, 23, 42);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text(pdfText(customer.business_name), 40, y, { maxWidth: 165 });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  const billLines = [
    `Attn: ${customer.owner_name}`,
    `Tel: ${customer.phone}`,
    customer.gst_number ? `GSTIN: ${customer.gst_number}` : "GSTIN: Unregistered",
    [customer.business_address, customer.city, customer.state, customer.pincode].filter(Boolean).join(", "),
  ].map((line) => pdfText(line));
  doc.text(billLines, 40, y + 14, { maxWidth: 165 });

  const addr = order.delivery_address;
  const shipLines = [
    addr?.contact_name || customer.owner_name,
    addr?.contact_phone || customer.phone,
    [addr?.address_line, addr?.city, addr?.state, addr?.pincode].filter(Boolean).join(", "),
  ]
    .filter(Boolean)
    .map((line) => pdfText(line));
  doc.setFont("helvetica", "normal");
  doc.text(shipLines, 220, y, { maxWidth: 165 });

  const invMeta = [
    ["Invoice No:", pdfText(invoice.invoice_number)],
    ["Invoice Date:", pdfText(formatDate(invoice.invoice_date))],
    ["Due Date:", pdfText(formatDate(invoice.due_date))],
    ["Order Ref:", pdfText(order.order_number)],
    ["Pay Status:", pdfText(invoice.payment_status.replace("_", " ").toUpperCase())],
  ];
  invMeta.forEach(([k, v], idx) => {
    const ry = y + idx * 14;
    doc.setFont("helvetica", "bold");
    doc.text(k, 400, ry);
    doc.setFont("helvetica", "normal");
    doc.text(v, 470, ry);
  });

  // Items Table (STRICTLY ZERO manufacturer/margin info)
  autoTable(doc, {
    startY: 205,
    head: [["#", "Description & SKU", "HSN", "Qty", "Rate", "GST %", "GST Amt", "Amount"]],
    body: items.map((item, idx) => [
      String(idx + 1),
      `${pdfText(item.product_name_snapshot)}\nSKU: ${pdfText(item.sku_snapshot)}`,
      pdfText(item.hsn_snapshot, "-"),
      `${formatQty(item.quantity)} ${pdfText(item.unit_snapshot)}`,
      formatPdfMoney(item.unit_selling_price, sym),
      `${item.gst_rate}%`,
      formatPdfMoney(item.tax_amount, sym),
      formatPdfMoney(item.line_total, sym),
    ]),
    styles: { fontSize: 8.5, cellPadding: 6, textColor: [15, 23, 42] },
    headStyles: { fillColor: [15, 23, 42], textColor: [255, 255, 255], fontStyle: "bold" },
    columnStyles: {
      0: { cellWidth: 24, halign: "center" },
      2: { cellWidth: 46, halign: "center" },
      3: { halign: "right" },
      4: { halign: "right" },
      5: { halign: "right" },
      6: { halign: "right" },
      7: { halign: "right", fontStyle: "bold" },
    },
    margin: { left: 40, right: 40 },
  });

  const tableEndY = getLastTableEndY(doc, 360);
  let y2 = tableEndY + 20;
  if (y2 > 640) {
    doc.addPage();
    y2 = 50;
  }

  // Bank Details + GST Breakdown
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text("Bank & Remittance Details", 40, y2 + 12);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.text(pdfText(agency.bank_details || `Payable to ${agency.legal_name || agency.agency_name}`), 40, y2 + 26, {
    maxWidth: 270,
  });

  doc.setDrawColor(203, 213, 225);
  doc.setFillColor(248, 250, 252);
  const boxHeight = invoice.is_inter_state ? 116 : 132;
  doc.roundedRect(330, y2, 225, boxHeight, 4, 4, "FD");

  let ty = y2 + 18;
  const drawRow = (label: string, val: string, bold = false) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(bold ? 10 : 9);
    doc.text(label, 344, ty);
    doc.text(val, 542, ty, { align: "right" });
    ty += 16;
  };

  drawRow("Taxable Value:", formatPdfMoney(invoice.subtotal, sym));
  if (invoice.is_inter_state) {
    drawRow("IGST:", formatPdfMoney(invoice.igst_amount, sym));
  } else {
    drawRow("CGST:", formatPdfMoney(invoice.cgst_amount, sym));
    drawRow("SGST:", formatPdfMoney(invoice.sgst_amount, sym));
  }
  doc.line(344, ty - 8, 542, ty - 8);
  drawRow("Invoice Total:", formatPdfMoney(invoice.total_amount, sym), true);
  drawRow("Amount Paid:", formatPdfMoney(invoice.paid_amount, sym));
  drawRow("Balance Due:", formatPdfMoney(Math.max(0, Number(invoice.total_amount) - Number(invoice.paid_amount)), sym), true);

  // Payment history table if any
  let afterBoxY = y2 + boxHeight + 22;
  if (payments.length > 0) {
    if (afterBoxY > 680) {
      doc.addPage();
      afterBoxY = 50;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.text("Recorded Payments", 40, afterBoxY);
    autoTable(doc, {
      startY: afterBoxY + 8,
      head: [["Date", "Method", "Reference No.", "Amount"]],
      body: payments.map((p) => [
        pdfText(formatDate(p.payment_date)),
        pdfText(p.payment_method),
        pdfText(p.reference_number, "-"),
        formatPdfMoney(p.amount, sym),
      ]),
      styles: { fontSize: 8, cellPadding: 4 },
      headStyles: { fillColor: [71, 85, 105], textColor: 255 },
      margin: { left: 40, right: 40 },
    });
  }

  if (agency.terms_and_conditions) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(71, 85, 105);
    doc.text("Terms & Conditions:", 40, 782);
    doc.setFont("helvetica", "normal");
    doc.text(pdfText(agency.terms_and_conditions), 40, 794, { maxWidth: 515 });
  }

  doc.save(`${pdfText(invoice.invoice_number, "INV")}.pdf`);
}

// ============================================================================
// ADMIN MASTER DATA & DOSSIER PDF TYPES
// ============================================================================

export interface PdfCustomerFinancialStats {
  activeOrderCount: number;
  cancelledOrderCount: number;
  totalOrdered: number;
  totalPaid: number;
  totalDue: number;
  savedAddressCount: number;
  customPriceCount: number;
}

export interface PdfCustomerAddressRow extends CustomerAddress {
  customer_business_name: string;
}

export interface PdfCustomerCustomPriceRow {
  id: string;
  customer_id: string;
  customer_business_name: string;
  product_id: string;
  product_name: string;
  sku: string;
  mfg_cost: number;
  standard_selling_price: number;
  custom_selling_price: number;
  is_active: boolean;
}

export interface AllCustomersPdfData {
  customers: CustomerProfile[];
  addresses: PdfCustomerAddressRow[];
  customPrices: PdfCustomerCustomPriceRow[];
  statsByCustomerId: Map<string, PdfCustomerFinancialStats>;
}

export interface AllCustomersPdfParams extends AllCustomersPdfData {
  agency: AgencySettings;
}

export interface CustomerDetailPdfParams {
  agency: AgencySettings;
  customer: CustomerProfile;
  addresses: CustomerAddress[];
  customPrices: PdfCustomerCustomPriceRow[];
  orders: OrderRecord[];
  invoices: InvoiceRecord[];
  payments: (PaymentRecord & { invoice_number?: string; order_number?: string })[];
}

export type ManufacturerWithCategories = Omit<Manufacturer, "categories"> & {
  categories?: Pick<Category, "id" | "name">[];
};

export interface AllManufacturersPdfData {
  manufacturers: ManufacturerWithCategories[];
  products: AdminProduct[];
  purchaseOrders: PurchaseOrderRecord[];
}

export interface AllManufacturersPdfParams extends AllManufacturersPdfData {
  agency: AgencySettings;
}

export interface ManufacturerDetailPdfParams {
  agency: AgencySettings;
  manufacturer: ManufacturerWithCategories;
  products: AdminProduct[];
  purchaseOrders: PurchaseOrderRecord[];
}

export interface PdfDetailedOrderItem extends OrderItemRecord {
  financial?: OrderItemFinancialRecord | null;
  linkedPoNumbers: string[];
}

export interface PdfDetailedOrderEntry {
  order: Omit<OrderRecord, "customers"> & { customers?: CustomerProfile | null };
  items: PdfDetailedOrderItem[];
  invoice: InvoiceRecord | null;
  payments: PaymentRecord[];
  purchaseOrders: PurchaseOrderRecord[];
  mfgCostTotal: number;
  grossMarginTotal: number;
}

export interface AllOrdersPdfData {
  entries: PdfDetailedOrderEntry[];
}

export interface AllOrdersPdfParams extends AllOrdersPdfData {
  agency: AgencySettings;
}

export interface AdminOrderDetailPdfParams {
  agency: AgencySettings;
  entry: PdfDetailedOrderEntry;
}

export interface MasterBusinessDataPdfParams {
  agency: AgencySettings;
  customersData: AllCustomersPdfData;
  manufacturersData: AllManufacturersPdfData;
  ordersData: AllOrdersPdfData;
}

export interface AnalyticsReportPdfParams {
  agency: AgencySettings;
  reportTitle: string;
  reportKey: string;
  dateRangeLabel: string;
  headers: string[];
  rows: (string | number)[][];
  rightAlignedCols?: number[];
  summaryNotes?: string[];
}

// ============================================================================
// INTERNAL SECTION RENDERERS (COMPOSED BY INDIVIDUAL & MASTER EXPORTS)
// ============================================================================

function renderAllCustomersSections(
  doc: jsPDF,
  agency: AgencySettings,
  data: AllCustomersPdfData,
  startY: number
): number {
  const sym = agency.currency_symbol || "₹";
  const { customers, addresses, customPrices, statsByCustomerId } = data;

  const activeCount = customers.filter((c) => c.status === "active").length;
  const pendingCount = customers.filter((c) => c.status === "pending").length;
  const inactiveCount = customers.length - activeCount - pendingCount;

  let grandOrdered = 0;
  let grandPaid = 0;
  let grandDue = 0;
  customers.forEach((c) => {
    const st = statsByCustomerId.get(c.id);
    if (st) {
      grandOrdered += st.totalOrdered;
      grandPaid += st.totalPaid;
      grandDue += st.totalDue;
    }
  });

  let y = drawKpiStrip(doc, startY, [
    {
      label: "Total Customers",
      value: String(customers.length),
      sub: `${activeCount} Active | ${pendingCount} Pending | ${inactiveCount} Other`,
      tone: "blue",
    },
    {
      label: "Saved Addresses",
      value: String(addresses.length),
      sub: `${customPrices.length} Custom Price Rules`,
    },
    {
      label: "Active Orders Value",
      value: formatPdfMoney(grandOrdered, sym),
      sub: "Excl. cancelled orders",
    },
    {
      label: "Total Paid Collected",
      value: formatPdfMoney(grandPaid, sym),
      tone: "green",
    },
    {
      label: "Total Amount Due",
      value: formatPdfMoney(grandDue, sym),
      tone: grandDue > 0 ? "red" : "green",
    },
  ]);

  // Section 1: Customer Directory
  y = drawSectionHeading(
    doc,
    y,
    `Registered Customer Businesses (${customers.length})`,
    "Complete business profiles, tax identifiers, status, saved contact details, and cumulative financial balances."
  );

  if (customers.length === 0) {
    y = drawMutedNote(doc, y, "No registered customer businesses found in the database.");
  } else {
    autoTable(doc, {
      startY: y,
      tableWidth: LANDSCAPE_TABLE_W,
      head: [
        [
          "#",
          "Business & Category",
          "Owner & Contact",
          "Registered Address",
          "GSTIN",
          "Status & Joined",
          "Orders",
          "Total Ordered",
          "Paid",
          "Due",
        ],
      ],
      body: customers.map((c, idx) => {
        const st = statsByCustomerId.get(c.id);
        const fullAddr = [c.business_address, c.city, c.state, c.pincode].filter(Boolean).join(", ");
        return [
          String(idx + 1),
          `${pdfText(c.business_name)}\n${pdfText(c.business_category, "Local Business")}`,
          `${pdfText(c.owner_name)}\n${pdfText(c.phone)}\n${pdfText(c.email)}`,
          pdfText(fullAddr),
          pdfText(c.gst_number, "Unregistered"),
          `${formatStatusLabel(c.status)}\n${pdfText(formatDate(c.registered_at))}`,
          String(st?.activeOrderCount ?? 0),
          formatPdfMoney(st?.totalOrdered ?? 0, sym),
          formatPdfMoney(st?.totalPaid ?? 0, sym),
          formatPdfMoney(st?.totalDue ?? 0, sym),
        ];
      }),
      foot: [
        [
          "",
          "TOTALS",
          `${customers.length} Businesses`,
          "",
          "",
          "",
          String(customers.reduce((s, c) => s + (statsByCustomerId.get(c.id)?.activeOrderCount ?? 0), 0)),
          formatPdfMoney(grandOrdered, sym),
          formatPdfMoney(grandPaid, sym),
          formatPdfMoney(grandDue, sym),
        ],
      ],
      styles: { fontSize: 7.4, cellPadding: 4.5, textColor: [15, 23, 42], overflow: "linebreak" },
      headStyles: { fillColor: [30, 64, 175], textColor: 255, fontStyle: "bold" },
      footStyles: { fillColor: [241, 245, 249], textColor: [15, 23, 42], fontStyle: "bold" },
      alternateRowStyles: { fillColor: [250, 251, 252] },
      columnStyles: {
        0: { cellWidth: 24, halign: "center" },
        1: { cellWidth: 112 },
        2: { cellWidth: 126 },
        3: { cellWidth: 145 },
        4: { cellWidth: 78 },
        5: { cellWidth: 66 },
        6: { cellWidth: 40, halign: "center" },
        7: { cellWidth: 62, halign: "right" },
        8: { cellWidth: 62, halign: "right" },
        9: { cellWidth: 62, halign: "right", fontStyle: "bold" },
      },
      margin: { top: TOP_NEXT_PAGE_Y, bottom: BOTTOM_FOOTER_RESERVE, left: MARGIN_X, right: MARGIN_X },
    });
    y = getLastTableEndY(doc, y + 60) + 18;
  }

  // Section 2: Saved Delivery Addresses
  y = drawSectionHeading(
    doc,
    y,
    `Customer Delivery Addresses (${addresses.length})`,
    "Additional shipping and warehouse addresses saved per customer account."
  );

  if (addresses.length === 0) {
    y = drawMutedNote(doc, y, "No additional saved delivery addresses recorded.");
  } else {
    autoTable(doc, {
      startY: y,
      tableWidth: LANDSCAPE_TABLE_W,
      head: [["Customer Business", "Label", "Recipient Contact", "Delivery Address", "City / State / Pincode", "Default"]],
      body: addresses.map((a) => [
        pdfText(a.customer_business_name),
        pdfText(a.label),
        `${pdfText(a.contact_name, "-")}\n${pdfText(a.contact_phone, "-")}`,
        pdfText(a.address_line),
        pdfText([a.city, a.state, a.pincode].filter(Boolean).join(", ")),
        a.is_default ? "Default" : "No",
      ]),
      styles: { fontSize: 7.5, cellPadding: 4.5, textColor: [15, 23, 42], overflow: "linebreak" },
      headStyles: { fillColor: [51, 65, 85], textColor: 255, fontStyle: "bold" },
      alternateRowStyles: { fillColor: [250, 251, 252] },
      columnStyles: {
        0: { cellWidth: 145, fontStyle: "bold" },
        1: { cellWidth: 90 },
        2: { cellWidth: 135 },
        3: { cellWidth: 230 },
        4: { cellWidth: 125 },
        5: { cellWidth: 52, halign: "center" },
      },
      margin: { top: TOP_NEXT_PAGE_Y, bottom: BOTTOM_FOOTER_RESERVE, left: MARGIN_X, right: MARGIN_X },
    });
    y = getLastTableEndY(doc, y + 60) + 18;
  }

  // Section 3: Customer-Specific Selling Prices
  y = drawSectionHeading(
    doc,
    y,
    `Customer-Specific Selling Price Overrides (${customPrices.length})`,
    "Internal Admin Record: Special per-customer contracted rates alongside manufacturer cost and realized margin."
  );

  if (customPrices.length === 0) {
    y = drawMutedNote(doc, y, "No customer-specific custom selling prices configured.");
  } else {
    autoTable(doc, {
      startY: y,
      tableWidth: LANDSCAPE_TABLE_W,
      head: [["Customer Business", "Product & SKU", "Mfg Cost", "Standard Price", "Custom Price", "Realized Margin", "Active"]],
      body: customPrices.map((cp) => {
        const realized = calculateRealizedGrossMargin(cp.custom_selling_price, cp.mfg_cost);
        return [
          pdfText(cp.customer_business_name),
          `${pdfText(cp.product_name)}\nSKU: ${pdfText(cp.sku)}`,
          formatPdfMoney(cp.mfg_cost, sym),
          formatPdfMoney(cp.standard_selling_price, sym),
          formatPdfMoney(cp.custom_selling_price, sym),
          `${formatPdfSignedMoney(realized.marginAmount, sym)} (${realized.marginPercentage}%)`,
          cp.is_active ? "Yes" : "No",
        ];
      }),
      styles: { fontSize: 7.5, cellPadding: 4.5, textColor: [15, 23, 42], overflow: "linebreak" },
      headStyles: { fillColor: [51, 65, 85], textColor: 255, fontStyle: "bold" },
      alternateRowStyles: { fillColor: [250, 251, 252] },
      columnStyles: {
        0: { cellWidth: 140, fontStyle: "bold" },
        1: { cellWidth: 185 },
        2: { cellWidth: 85, halign: "right" },
        3: { cellWidth: 85, halign: "right" },
        4: { cellWidth: 85, halign: "right", fontStyle: "bold" },
        5: { cellWidth: 137, halign: "right" },
        6: { cellWidth: 60, halign: "center" },
      },
      margin: { top: TOP_NEXT_PAGE_Y, bottom: BOTTOM_FOOTER_RESERVE, left: MARGIN_X, right: MARGIN_X },
    });
    y = getLastTableEndY(doc, y + 60) + 18;
  }

  return y;
}

function renderAllManufacturersSections(
  doc: jsPDF,
  agency: AgencySettings,
  data: AllManufacturersPdfData,
  startY: number
): number {
  const sym = agency.currency_symbol || "₹";
  const { manufacturers, products, purchaseOrders } = data;

  const activeMfgCount = manufacturers.filter((m) => m.status === "active").length;
  const publishedProdCount = products.filter((p) => p.is_published).length;
  const draftProdCount = products.length - publishedProdCount;

  let totalAvailUnits = 0;
  let totalStockCostVal = 0;
  const prodCountByMfg = new Map<string, number>();
  const mfgNameById = new Map<string, string>();
  manufacturers.forEach((m) => mfgNameById.set(m.id, m.company_name));

  products.forEach((p) => {
    prodCountByMfg.set(p.manufacturer_id, (prodCountByMfg.get(p.manufacturer_id) ?? 0) + 1);
    const avail = Number(p.inventory?.available_quantity ?? 0);
    const cost = Number(p.product_prices?.draft_manufacturer_price ?? p.product_prices?.published_manufacturer_price ?? 0);
    totalAvailUnits += avail;
    totalStockCostVal += avail * cost;
  });

  const activePos = purchaseOrders.filter((po) => po.status !== "Cancelled");
  const totalPoVal = activePos.reduce((s, po) => s + Number(po.total_amount ?? 0), 0);
  const poStatsByMfg = new Map<string, { count: number; total: number }>();
  activePos.forEach((po) => {
    const prev = poStatsByMfg.get(po.manufacturer_id) ?? { count: 0, total: 0 };
    prev.count += 1;
    prev.total += Number(po.total_amount ?? 0);
    poStatsByMfg.set(po.manufacturer_id, prev);
  });

  let y = drawKpiStrip(doc, startY, [
    {
      label: "Total Manufacturers",
      value: String(manufacturers.length),
      sub: `${activeMfgCount} Active | ${manufacturers.length - activeMfgCount} Inactive`,
      tone: "blue",
    },
    {
      label: "Catalog Products",
      value: String(products.length),
      sub: `${publishedProdCount} Published | ${draftProdCount} Draft`,
    },
    {
      label: "Available Inventory",
      value: `${formatQty(totalAvailUnits)} units`,
      sub: `Cost Value: ${formatPdfMoney(totalStockCostVal, sym)}`,
    },
    {
      label: "Active Purchase Orders",
      value: String(activePos.length),
      sub: `${purchaseOrders.length - activePos.length} Cancelled PO(s)`,
    },
    {
      label: "Total PO Procurement",
      value: formatPdfMoney(totalPoVal, sym),
      tone: "green",
    },
  ]);

  // Section 1: Manufacturers Directory
  y = drawSectionHeading(
    doc,
    y,
    `Manufacturer Directory (${manufacturers.length})`,
    "Supplier company profiles, contacts, addresses, GSTIN, supplied categories, SKU counts, and procurement volume."
  );

  if (manufacturers.length === 0) {
    y = drawMutedNote(doc, y, "No manufacturers registered yet.");
  } else {
    autoTable(doc, {
      startY: y,
      tableWidth: LANDSCAPE_TABLE_W,
      head: [["#", "Company & Bio", "Contact & Phone", "Email & Website", "Address", "GSTIN", "Categories", "Status / SKUs / POs"]],
      body: manufacturers.map((m, idx) => {
        const cats = (m.categories ?? []).map((c) => c.name).filter(Boolean).join(", ");
        const fullAddr = [m.address, m.city, m.state].filter(Boolean).join(", ");
        const skuCount = prodCountByMfg.get(m.id) ?? 0;
        const poStat = poStatsByMfg.get(m.id);
        return [
          String(idx + 1),
          `${pdfText(m.company_name)}${m.description ? `\n${pdfText(m.description)}` : ""}`,
          `${pdfText(m.contact_person)}\n${pdfText(m.phone)}`,
          `${pdfText(m.email, "-")}\n${pdfText(m.website, "-")}`,
          pdfText(fullAddr),
          pdfText(m.gst_number, "-"),
          pdfText(cats, "-"),
          `${formatStatusLabel(m.status)}\n${skuCount} SKU(s)\n${poStat?.count ?? 0} PO (${formatPdfMoney(poStat?.total ?? 0, sym)})`,
        ];
      }),
      styles: { fontSize: 7.4, cellPadding: 4.5, textColor: [15, 23, 42], overflow: "linebreak" },
      headStyles: { fillColor: [30, 64, 175], textColor: 255, fontStyle: "bold" },
      alternateRowStyles: { fillColor: [250, 251, 252] },
      columnStyles: {
        0: { cellWidth: 24, halign: "center" },
        1: { cellWidth: 125, fontStyle: "bold" },
        2: { cellWidth: 105 },
        3: { cellWidth: 115 },
        4: { cellWidth: 135 },
        5: { cellWidth: 78 },
        6: { cellWidth: 95 },
        7: { cellWidth: 100 },
      },
      margin: { top: TOP_NEXT_PAGE_Y, bottom: BOTTOM_FOOTER_RESERVE, left: MARGIN_X, right: MARGIN_X },
    });
    y = getLastTableEndY(doc, y + 60) + 18;
  }

  // Section 2: Complete Manufacturer Product Catalog & Pricing
  const sortedProducts = [...products].sort((a, b) => {
    const ma = a.manufacturer?.company_name || mfgNameById.get(a.manufacturer_id) || "";
    const mb = b.manufacturer?.company_name || mfgNameById.get(b.manufacturer_id) || "";
    const cmp = ma.localeCompare(mb);
    return cmp !== 0 ? cmp : a.name.localeCompare(b.name);
  });

  y = drawSectionHeading(
    doc,
    y,
    `Manufacturer Product Catalog, Costing & Stock (${sortedProducts.length} SKUs)`,
    "Internal Pricing Record: Original manufacturer costs, configured margins, live vs draft selling prices, GST %, and stock levels."
  );

  if (sortedProducts.length === 0) {
    y = drawMutedNote(doc, y, "No products found for the selected manufacturer(s).");
  } else {
    autoTable(doc, {
      startY: y,
      tableWidth: LANDSCAPE_TABLE_W,
      head: [
        [
          "Manufacturer",
          "Product & SKU",
          "Category / HSN",
          "Unit / MOQ",
          "Orig. Mfg",
          "Margin",
          "Selling Price",
          "GST %",
          "Stock (Avl/Res/Sld)",
          "Status",
        ],
      ],
      body: sortedProducts.map((p) => {
        const mName = p.manufacturer?.company_name || mfgNameById.get(p.manufacturer_id) || "-";
        const pp = p.product_prices;
        const mfgPrice = pp?.draft_manufacturer_price ?? pp?.published_manufacturer_price ?? 0;
        const marginPct = pp?.draft_margin_percentage ?? pp?.published_margin_percentage ?? 0;
        const marginAmt = pp?.draft_margin_amount ?? pp?.published_margin_amount ?? 0;
        const pubSell = Number(pp?.published_selling_price ?? 0);
        const draftSell = Number(pp?.draft_selling_price ?? 0);
        const sellCol =
          p.is_published && Math.abs(pubSell - draftSell) > 0.005
            ? `Live: ${formatPdfMoney(pubSell, sym)}\nDraft: ${formatPdfMoney(draftSell, sym)}`
            : p.is_published
              ? formatPdfMoney(pubSell, sym)
              : `Draft: ${formatPdfMoney(draftSell, sym)}`;
        const inv = p.inventory;
        const stockText = `${formatQty(inv?.available_quantity ?? 0)} / ${formatQty(inv?.reserved_quantity ?? 0)} / ${formatQty(inv?.sold_quantity ?? 0)}`;
        const pubStatus = p.is_published ? "Published" : "Draft";

        return [
          pdfText(mName),
          `${pdfText(p.name)}\nSKU: ${pdfText(p.sku)}`,
          `${pdfText(p.category?.name, "-")}\nHSN: ${pdfText(p.hsn_code, "-")}`,
          `${pdfText(p.unit_of_measurement)}\nMOQ: ${formatQty(p.min_order_quantity)}`,
          formatPdfMoney(mfgPrice, sym),
          `${Number(marginPct)}%\n(${formatPdfMoney(marginAmt, sym)})`,
          sellCol,
          `${p.gst_rate}%`,
          stockText,
          `${pubStatus}\n${formatStatusLabel(p.status)}`,
        ];
      }),
      styles: { fontSize: 7.2, cellPadding: 4, textColor: [15, 23, 42], overflow: "linebreak" },
      headStyles: { fillColor: [51, 65, 85], textColor: 255, fontStyle: "bold" },
      alternateRowStyles: { fillColor: [250, 251, 252] },
      columnStyles: {
        0: { cellWidth: 98, fontStyle: "bold" },
        1: { cellWidth: 140 },
        2: { cellWidth: 80 },
        3: { cellWidth: 55 },
        4: { cellWidth: 65, halign: "right" },
        5: { cellWidth: 68, halign: "right" },
        6: { cellWidth: 78, halign: "right", fontStyle: "bold" },
        7: { cellWidth: 40, halign: "right" },
        8: { cellWidth: 85, halign: "right" },
        9: { cellWidth: 68, halign: "center" },
      },
      margin: { top: TOP_NEXT_PAGE_Y, bottom: BOTTOM_FOOTER_RESERVE, left: MARGIN_X, right: MARGIN_X },
    });
    y = getLastTableEndY(doc, y + 60) + 18;
  }

  // Section 3: Manufacturer Purchase Orders
  y = drawSectionHeading(
    doc,
    y,
    `Manufacturer Purchase Orders (${purchaseOrders.length})`,
    "Procurement PO history issued to manufacturers with status, invoice references, and totals."
  );

  if (purchaseOrders.length === 0) {
    y = drawMutedNote(doc, y, "No purchase orders recorded.");
  } else {
    autoTable(doc, {
      startY: y,
      tableWidth: LANDSCAPE_TABLE_W,
      head: [["PO Number", "Manufacturer", "Source Order", "Date / Expected", "Status", "Mfg Invoice #", "Subtotal", "GST", "Total Amount"]],
      body: purchaseOrders.map((po) => [
        pdfText(po.po_number),
        pdfText(po.manufacturers?.company_name || mfgNameById.get(po.manufacturer_id), "-"),
        pdfText(po.orders?.order_number, "Stock Replenish"),
        `${pdfText(formatDate(po.created_at))}\nExp: ${po.expected_delivery_date ? pdfText(formatDate(po.expected_delivery_date)) : "Schedule"}`,
        pdfText(po.status),
        pdfText(po.manufacturer_invoice_number, "-"),
        formatPdfMoney(po.subtotal, sym),
        formatPdfMoney(po.tax_total, sym),
        formatPdfMoney(po.total_amount, sym),
      ]),
      styles: { fontSize: 7.4, cellPadding: 4.5, textColor: [15, 23, 42], overflow: "linebreak" },
      headStyles: { fillColor: [51, 65, 85], textColor: 255, fontStyle: "bold" },
      alternateRowStyles: { fillColor: [250, 251, 252] },
      columnStyles: {
        0: { cellWidth: 78, fontStyle: "bold" },
        1: { cellWidth: 125 },
        2: { cellWidth: 78 },
        3: { cellWidth: 95 },
        4: { cellWidth: 78 },
        5: { cellWidth: 75 },
        6: { cellWidth: 82, halign: "right" },
        7: { cellWidth: 76, halign: "right" },
        8: { cellWidth: 90, halign: "right", fontStyle: "bold" },
      },
      margin: { top: TOP_NEXT_PAGE_Y, bottom: BOTTOM_FOOTER_RESERVE, left: MARGIN_X, right: MARGIN_X },
    });
    y = getLastTableEndY(doc, y + 60) + 18;
  }

  return y;
}

function renderOrderLineItemsBlock(
  doc: jsPDF,
  entry: PdfDetailedOrderEntry,
  sym: string,
  startY: number
): number {
  const { order, items, invoice, payments, purchaseOrders, mfgCostTotal, grossMarginTotal } = entry;
  const pageWidth = doc.internal.pageSize.getWidth();
  const usableW = pageWidth - MARGIN_X * 2;
  const cust = order.customers;
  const addr = order.delivery_address;
  const paidAmt = Number(order.paid_amount ?? 0);
  const dueAmt =
    order.order_status === "Cancelled"
      ? 0
      : Math.max(0, Number(order.due_amount ?? Number(order.total_amount) - paidAmt));

  const poNums = purchaseOrders.map((po) => `${po.po_number} (${po.status})`).join(", ") || "No PO split yet";
  const invLabel = invoice ? `${invoice.invoice_number} (${formatStatusLabel(invoice.payment_status)})` : "No Invoice yet";
  const shipAddr = [addr?.address_line, addr?.city, addr?.state, addr?.pincode].filter(Boolean).join(", ");
  const shipContact = [addr?.contact_name || cust?.owner_name, addr?.contact_phone || cust?.phone].filter(Boolean).join(" / ");

  let y = ensureSpace(doc, startY, 120);

  // Compact shaded Order Header Card
  doc.setDrawColor(203, 213, 225);
  doc.setFillColor(241, 245, 249);
  const headerCardH = order.notes ? 48 : 38;
  doc.roundedRect(MARGIN_X, y, usableW, headerCardH, 3, 3, "FD");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.8);
  doc.setTextColor(15, 23, 42);
  doc.text(
    pdfText(`${order.order_number}   |   ${cust?.business_name || "Customer"}   |   Placed: ${formatDateTime(order.placed_at)}`),
    MARGIN_X + 8,
    y + 13,
    { maxWidth: usableW * 0.68 }
  );

  doc.setFontSize(8.2);
  doc.setTextColor(30, 64, 175);
  doc.text(
    pdfText(`Status: ${order.order_status}  |  Payment: ${formatStatusLabel(order.payment_status)}`),
    pageWidth - MARGIN_X - 8,
    y + 13,
    { align: "right" }
  );

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(51, 65, 85);
  doc.text(
    pdfText(`Ship To: ${shipContact} - ${shipAddr}   |   Invoice: ${invLabel}   |   POs: ${poNums}`),
    MARGIN_X + 8,
    y + 27,
    { maxWidth: usableW - 16 }
  );

  if (order.notes) {
    doc.setTextColor(100, 116, 139);
    doc.text(pdfText(`Order Notes: ${order.notes}`), MARGIN_X + 8, y + 39, { maxWidth: usableW - 16 });
  }

  y += headerCardH + 4;

  const activePayments = payments.filter((p) => p.status !== "voided");
  const paymentSummaryText =
    activePayments.length > 0
      ? `Payments (${activePayments.length}): ` +
        activePayments.map((p) => `${formatDate(p.payment_date)} ${p.payment_method} ${formatPdfMoney(p.amount, sym)}`).join("; ")
      : "No recorded payments";

  autoTable(doc, {
    startY: y,
    tableWidth: LANDSCAPE_TABLE_W,
    head: [
      [
        "#",
        "Product Name & SKU",
        "HSN",
        "Manufacturer",
        "Qty & Unit",
        "Mfg Rate",
        "Margin",
        "Cust. Rate",
        "GST",
        "Line Total",
        "Linked PO",
      ],
    ],
    body:
      items.length === 0
        ? [["-", "No line items found for this order", "-", "-", "-", "-", "-", "-", "-", "-", "-"]]
        : items.map((item, idx) => {
            const fin = item.financial;
            return [
              String(idx + 1),
              `${pdfText(item.product_name_snapshot)}\nSKU: ${pdfText(item.sku_snapshot)}`,
              pdfText(item.hsn_snapshot, "-"),
              pdfText(fin?.manufacturer_name_snapshot, "-"),
              `${formatQty(item.quantity)} ${pdfText(item.unit_snapshot)}`,
              fin ? formatPdfMoney(fin.unit_manufacturer_price, sym) : "-",
              fin ? `${fin.margin_percentage_snapshot}%\n(${formatPdfSignedMoney(fin.margin_amount_total, sym)})` : "-",
              formatPdfMoney(item.unit_selling_price, sym),
              `${item.gst_rate}%\n(${formatPdfMoney(item.tax_amount, sym)})`,
              formatPdfMoney(item.line_total, sym),
              pdfText(item.linkedPoNumbers.join(", "), "Unassigned"),
            ];
          }),
    foot: [
      [
        "",
        pdfText(paymentSummaryText),
        "",
        "TOTALS",
        `${items.length} line(s)`,
        `Cost: ${formatPdfMoney(mfgCostTotal, sym)}`,
        `Margin: ${formatPdfSignedMoney(grossMarginTotal, sym)}`,
        `Sub: ${formatPdfMoney(order.subtotal, sym)}`,
        `GST: ${formatPdfMoney(order.tax_total, sym)}`,
        formatPdfMoney(order.total_amount, sym),
        `Paid: ${formatPdfMoney(paidAmt, sym)}\nDue: ${formatPdfMoney(dueAmt, sym)}`,
      ],
    ],
    styles: { fontSize: 7.2, cellPadding: 4, textColor: [15, 23, 42], overflow: "linebreak" },
    headStyles: { fillColor: [51, 65, 85], textColor: 255, fontStyle: "bold" },
    footStyles: { fillColor: [248, 250, 252], textColor: [15, 23, 42], fontStyle: "bold", fontSize: 7 },
    alternateRowStyles: { fillColor: [250, 251, 252] },
    columnStyles: {
      0: { cellWidth: 22, halign: "center" },
      1: { cellWidth: 145 },
      2: { cellWidth: 42, halign: "center" },
      3: { cellWidth: 90 },
      4: { cellWidth: 56, halign: "right" },
      5: { cellWidth: 64, halign: "right" },
      6: { cellWidth: 74, halign: "right" },
      7: { cellWidth: 68, halign: "right" },
      8: { cellWidth: 66, halign: "right" },
      9: { cellWidth: 76, halign: "right", fontStyle: "bold" },
      10: { cellWidth: 74, halign: "center" },
    },
    margin: { top: TOP_NEXT_PAGE_Y, bottom: BOTTOM_FOOTER_RESERVE, left: MARGIN_X, right: MARGIN_X },
  });

  return getLastTableEndY(doc, y + 70) + 14;
}

function renderAllOrdersSections(
  doc: jsPDF,
  agency: AgencySettings,
  data: AllOrdersPdfData,
  startY: number
): number {
  const sym = agency.currency_symbol || "₹";
  const { entries } = data;

  const activeEntries = entries.filter((e) => e.order.order_status !== "Cancelled");
  const cancelledCount = entries.length - activeEntries.length;

  const totalRevenue = activeEntries.reduce((s, e) => s + Number(e.order.total_amount ?? 0), 0);
  const totalTax = activeEntries.reduce((s, e) => s + Number(e.order.tax_total ?? 0), 0);
  const totalPaid = activeEntries.reduce((s, e) => s + Number(e.order.paid_amount ?? 0), 0);
  const totalDue = activeEntries.reduce(
    (s, e) => s + Math.max(0, Number(e.order.due_amount ?? Number(e.order.total_amount) - Number(e.order.paid_amount ?? 0))),
    0
  );
  const totalMfgCost = activeEntries.reduce((s, e) => s + e.mfgCostTotal, 0);
  const totalMargin = activeEntries.reduce((s, e) => s + e.grossMarginTotal, 0);

  let y = drawKpiStrip(doc, startY, [
    {
      label: "Total Orders",
      value: String(entries.length),
      sub: `${activeEntries.length} Active | ${cancelledCount} Cancelled`,
      tone: "blue",
    },
    {
      label: "Active Order Revenue",
      value: formatPdfMoney(totalRevenue, sym),
      sub: `Includes GST: ${formatPdfMoney(totalTax, sym)}`,
    },
    {
      label: "Paid Collected",
      value: formatPdfMoney(totalPaid, sym),
      tone: "green",
    },
    {
      label: "Amount Due",
      value: formatPdfMoney(totalDue, sym),
      tone: totalDue > 0 ? "red" : "green",
    },
    {
      label: "Est. Gross Margin",
      value: formatPdfSignedMoney(totalMargin, sym),
      sub: `Mfg Cost: ${formatPdfMoney(totalMfgCost, sym)}`,
      tone: totalMargin < 0 ? "red" : "green",
    },
  ]);

  // Section 1: Master Order Register
  y = drawSectionHeading(
    doc,
    y,
    `All Orders Master Register (${entries.length})`,
    "High-level financial, fulfillment, invoice, PO, cost, margin, and payment summary across every placed order."
  );

  if (entries.length === 0) {
    return drawMutedNote(doc, y, "No customer orders recorded in the database.");
  }

  autoTable(doc, {
    startY: y,
    tableWidth: LANDSCAPE_TABLE_W,
    head: [
      [
        "Order # & Placed",
        "Customer & Contact",
        "Delivery Address",
        "Lines / Qty",
        "Subtotal / GST",
        "Grand Total",
        "Paid / Due",
        "Mfg Cost / Margin",
        "Status / Refs",
      ],
    ],
    body: entries.map((e) => {
      const o = e.order;
      const addr = o.delivery_address;
      const totalQty = e.items.reduce((s, i) => s + Number(i.quantity), 0);
      const paidAmt = Number(o.paid_amount ?? 0);
      const dueAmt =
        o.order_status === "Cancelled"
          ? 0
          : Math.max(0, Number(o.due_amount ?? Number(o.total_amount) - paidAmt));
      const poNums = e.purchaseOrders.map((po) => po.po_number).join(", ");
      const fullAddr = [addr?.address_line, addr?.city, addr?.state, addr?.pincode].filter(Boolean).join(", ");

      return [
        `${pdfText(o.order_number)}\n${pdfText(formatDate(o.placed_at))}`,
        `${pdfText(o.customers?.business_name, "Unknown")}\n${pdfText(o.customers?.phone, "-")}${
          o.customers?.gst_number ? `\nGSTIN: ${pdfText(o.customers.gst_number)}` : ""
        }`,
        pdfText(fullAddr),
        `${e.items.length} line(s)\n${formatQty(totalQty)} units`,
        `Sub: ${formatPdfMoney(o.subtotal, sym)}\nGST: ${formatPdfMoney(o.tax_total, sym)}`,
        formatPdfMoney(o.total_amount, sym),
        `Paid: ${formatPdfMoney(paidAmt, sym)}\nDue: ${o.order_status === "Cancelled" ? "Void" : formatPdfMoney(dueAmt, sym)}`,
        `Cost: ${formatPdfMoney(e.mfgCostTotal, sym)}\nMargin: ${formatPdfSignedMoney(e.grossMarginTotal, sym)}`,
        `${pdfText(o.order_status)}\nPay: ${formatStatusLabel(o.payment_status)}\nInv: ${pdfText(e.invoice?.invoice_number, "-")}${
          poNums ? `\nPO: ${pdfText(poNums)}` : ""
        }`,
      ];
    }),
    foot: [
      [
        "ACTIVE TOTALS",
        `${activeEntries.length} active (${cancelledCount} cancelled)`,
        "",
        "",
        `GST: ${formatPdfMoney(totalTax, sym)}`,
        formatPdfMoney(totalRevenue, sym),
        `Paid: ${formatPdfMoney(totalPaid, sym)}\nDue: ${formatPdfMoney(totalDue, sym)}`,
        `Cost: ${formatPdfMoney(totalMfgCost, sym)}\nMargin: ${formatPdfSignedMoney(totalMargin, sym)}`,
        "",
      ],
    ],
    styles: { fontSize: 7.2, cellPadding: 4.5, textColor: [15, 23, 42], overflow: "linebreak" },
    headStyles: { fillColor: [30, 64, 175], textColor: 255, fontStyle: "bold" },
    footStyles: { fillColor: [241, 245, 249], textColor: [15, 23, 42], fontStyle: "bold" },
    alternateRowStyles: { fillColor: [250, 251, 252] },
    columnStyles: {
      0: { cellWidth: 86, fontStyle: "bold" },
      1: { cellWidth: 115 },
      2: { cellWidth: 125 },
      3: { cellWidth: 55, halign: "right" },
      4: { cellWidth: 78, halign: "right" },
      5: { cellWidth: 72, halign: "right", fontStyle: "bold" },
      6: { cellWidth: 78, halign: "right" },
      7: { cellWidth: 82, halign: "right" },
      8: { cellWidth: 86 },
    },
    margin: { top: TOP_NEXT_PAGE_Y, bottom: BOTTOM_FOOTER_RESERVE, left: MARGIN_X, right: MARGIN_X },
  });
  y = getLastTableEndY(doc, y + 60) + 18;

  // Section 2: Complete Order-by-Order Item, Costing, Margin & PO Breakdown
  y = drawSectionHeading(
    doc,
    y,
    `Complete Order-by-Order Item, Costing & PO Breakdown (${entries.length} Orders)`,
    "Full SKU, manufacturer allocation, manufacturer unit rate, margin %, selling rate, GST, line totals, linked POs, and notes."
  );

  for (const entry of entries) {
    y = renderOrderLineItemsBlock(doc, entry, sym, y);
  }

  // Section 3: Payment Transactions Ledger
  const allPayments: {
    payment_date: string;
    order_number: string;
    invoice_number: string;
    customer_name: string;
    payment_method: string;
    reference_number: string | null;
    amount: number;
    status: string;
    notes: string | null;
  }[] = [];

  entries.forEach((e) => {
    e.payments.forEach((p) => {
      allPayments.push({
        payment_date: p.payment_date,
        order_number: e.order.order_number,
        invoice_number: e.invoice?.invoice_number || "-",
        customer_name: e.order.customers?.business_name || "Unknown",
        payment_method: p.payment_method,
        reference_number: p.reference_number,
        amount: Number(p.amount),
        status: p.status,
        notes: p.notes,
      });
    });
  });

  y = drawSectionHeading(
    doc,
    y,
    `Payment Transactions Ledger (${allPayments.length})`,
    "Chronological log of all payments recorded across customer orders and invoices."
  );

  if (allPayments.length === 0) {
    y = drawMutedNote(doc, y, "No payment transactions recorded yet.");
  } else {
    autoTable(doc, {
      startY: y,
      tableWidth: LANDSCAPE_TABLE_W,
      head: [["Payment Date", "Order #", "Invoice #", "Customer Business", "Method & Ref", "Amount", "Status", "Notes"]],
      body: allPayments.map((p) => [
        pdfText(formatDate(p.payment_date)),
        pdfText(p.order_number),
        pdfText(p.invoice_number),
        pdfText(p.customer_name),
        `${pdfText(p.payment_method)}${p.reference_number ? `\nRef: ${pdfText(p.reference_number)}` : ""}`,
        formatPdfMoney(p.amount, sym),
        formatStatusLabel(p.status),
        pdfText(p.notes, "-"),
      ]),
      styles: { fontSize: 7.4, cellPadding: 4.5, textColor: [15, 23, 42], overflow: "linebreak" },
      headStyles: { fillColor: [51, 65, 85], textColor: 255, fontStyle: "bold" },
      alternateRowStyles: { fillColor: [250, 251, 252] },
      columnStyles: {
        0: { cellWidth: 72 },
        1: { cellWidth: 85, fontStyle: "bold" },
        2: { cellWidth: 85 },
        3: { cellWidth: 145 },
        4: { cellWidth: 125 },
        5: { cellWidth: 85, halign: "right", fontStyle: "bold" },
        6: { cellWidth: 60, halign: "center" },
        7: { cellWidth: 120 },
      },
      margin: { top: TOP_NEXT_PAGE_Y, bottom: BOTTOM_FOOTER_RESERVE, left: MARGIN_X, right: MARGIN_X },
    });
    y = getLastTableEndY(doc, y + 60) + 18;
  }

  return y;
}

// ============================================================================
// PUBLIC BUILDER & SAVE FUNCTIONS FOR ADMIN EXPORTS
// ============================================================================

export function buildAllCustomersPdfDoc(params: AllCustomersPdfParams): jsPDF {
  const { agency, ...data } = params;
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });
  const startY = drawDocumentHeader(doc, {
    agency,
    title: "ALL CUSTOMERS DATA REPORT",
    subtitle: `${data.customers.length} Customer Businesses | ${data.addresses.length} Addresses | ${data.customPrices.length} Custom Prices`,
    rightMeta: [`Exported: ${formatDateTime(new Date().toISOString())}`, "Internal Admin / Confidential"],
  });
  renderAllCustomersSections(doc, agency, data, startY);
  addPageFooters(doc, `${agency.agency_name} - All Customers Directory & Financials Export`);
  return doc;
}

export function generateAllCustomersPdf(params: AllCustomersPdfParams): void {
  const doc = buildAllCustomersPdfDoc(params);
  doc.save(`all-customers-${toLocalDateString()}.pdf`);
}

export function buildCustomerDetailPdfDoc(params: CustomerDetailPdfParams): jsPDF {
  const { agency, customer, addresses, customPrices, orders, invoices, payments } = params;
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "portrait" });
  const sym = agency.currency_symbol || "₹";
  const pageWidth = doc.internal.pageSize.getWidth();

  let y = drawDocumentHeader(doc, {
    agency,
    title: "CUSTOMER PROFILE REPORT",
    subtitle: customer.business_name,
    rightMeta: [`Status: ${formatStatusLabel(customer.status)}`, `Exported: ${formatDateTime(new Date().toISOString())}`],
  });

  // Customer Metadata Box
  const activeOrders = orders.filter((o) => o.order_status !== "Cancelled");
  const totalOrdered = activeOrders.reduce((s, o) => s + Number(o.total_amount ?? 0), 0);
  const totalPaid = activeOrders.reduce((s, o) => s + Number(o.paid_amount ?? 0), 0);
  const totalDue = activeOrders.reduce(
    (s, o) => s + Math.max(0, Number(o.due_amount ?? Number(o.total_amount) - Number(o.paid_amount ?? 0))),
    0
  );

  doc.setDrawColor(203, 213, 225);
  doc.setFillColor(248, 250, 252);
  doc.roundedRect(MARGIN_X, y, pageWidth - MARGIN_X * 2, 86, 4, 4, "FD");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text(pdfText(customer.business_name), MARGIN_X + 10, y + 18, { maxWidth: 320 });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  const fullAddr = [customer.business_address, customer.city, customer.state, customer.pincode].filter(Boolean).join(", ");
  doc.text(pdfText(`Owner: ${customer.owner_name}   |   Category: ${customer.business_category || "Local Business"}`), MARGIN_X + 10, y + 33);
  doc.text(pdfText(`Phone: ${customer.phone}   |   Email: ${customer.email}`), MARGIN_X + 10, y + 46);
  doc.text(pdfText(`GSTIN: ${customer.gst_number || "Unregistered"}   |   Joined: ${formatDate(customer.registered_at)}`), MARGIN_X + 10, y + 59);
  doc.text(pdfText(`Address: ${fullAddr}`), MARGIN_X + 10, y + 73, { maxWidth: pageWidth - MARGIN_X * 2 - 20 });

  y += 100;
  y = drawKpiStrip(doc, y, [
    { label: "Active Orders", value: String(activeOrders.length), sub: `${orders.length - activeOrders.length} Cancelled`, tone: "blue" },
    { label: "Active Orders Total", value: formatPdfMoney(totalOrdered, sym) },
    { label: "Paid to Date", value: formatPdfMoney(totalPaid, sym), tone: "green" },
    { label: "Outstanding Due", value: formatPdfMoney(totalDue, sym), tone: totalDue > 0 ? "red" : "green" },
  ]);

  // Delivery Addresses
  y = drawSectionHeading(doc, y, `Saved Delivery Addresses (${addresses.length})`);
  if (addresses.length === 0) {
    y = drawMutedNote(doc, y, "No additional saved delivery addresses recorded.");
  } else {
    autoTable(doc, {
      startY: y,
      tableWidth: PORTRAIT_TABLE_W,
      head: [["Label", "Contact", "Address", "City / State / Pincode", "Default"]],
      body: addresses.map((a) => [
        pdfText(a.label),
        `${pdfText(a.contact_name, "-")}\n${pdfText(a.contact_phone, "-")}`,
        pdfText(a.address_line),
        pdfText([a.city, a.state, a.pincode].filter(Boolean).join(", ")),
        a.is_default ? "Default" : "No",
      ]),
      styles: { fontSize: 8, cellPadding: 4.5, overflow: "linebreak" },
      headStyles: { fillColor: [51, 65, 85], textColor: 255, fontStyle: "bold" },
      columnStyles: {
        0: { cellWidth: 75, fontStyle: "bold" },
        1: { cellWidth: 95 },
        2: { cellWidth: 185 },
        3: { cellWidth: 120 },
        4: { cellWidth: 56, halign: "center" },
      },
      margin: { top: TOP_NEXT_PAGE_Y, bottom: BOTTOM_FOOTER_RESERVE, left: MARGIN_X, right: MARGIN_X },
    });
    y = getLastTableEndY(doc, y + 50) + 16;
  }

  // Custom Selling Prices
  y = drawSectionHeading(doc, y, `Customer-Specific Selling Prices (${customPrices.length})`);
  if (customPrices.length === 0) {
    y = drawMutedNote(doc, y, "No custom price overrides assigned; standard catalog pricing applies.");
  } else {
    autoTable(doc, {
      startY: y,
      tableWidth: PORTRAIT_TABLE_W,
      head: [["Product & SKU", "Mfg Cost", "Standard Price", "Custom Price", "Realized Margin"]],
      body: customPrices.map((cp) => {
        const realized = calculateRealizedGrossMargin(cp.custom_selling_price, cp.mfg_cost);
        return [
          `${pdfText(cp.product_name)}\nSKU: ${pdfText(cp.sku)}`,
          formatPdfMoney(cp.mfg_cost, sym),
          formatPdfMoney(cp.standard_selling_price, sym),
          formatPdfMoney(cp.custom_selling_price, sym),
          `${formatPdfSignedMoney(realized.marginAmount, sym)} (${realized.marginPercentage}%)`,
        ];
      }),
      styles: { fontSize: 8, cellPadding: 4.5, overflow: "linebreak" },
      headStyles: { fillColor: [51, 65, 85], textColor: 255, fontStyle: "bold" },
      columnStyles: {
        0: { cellWidth: 185 },
        1: { cellWidth: 78, halign: "right" },
        2: { cellWidth: 85, halign: "right" },
        3: { cellWidth: 85, halign: "right", fontStyle: "bold" },
        4: { cellWidth: 98, halign: "right" },
      },
      margin: { top: TOP_NEXT_PAGE_Y, bottom: BOTTOM_FOOTER_RESERVE, left: MARGIN_X, right: MARGIN_X },
    });
    y = getLastTableEndY(doc, y + 50) + 16;
  }

  // Orders Table
  y = drawSectionHeading(doc, y, `Order History (${orders.length})`);
  if (orders.length === 0) {
    y = drawMutedNote(doc, y, "No orders placed by this customer yet.");
  } else {
    autoTable(doc, {
      startY: y,
      tableWidth: PORTRAIT_TABLE_W,
      head: [["Order #", "Date", "Order Status", "Pay Status", "Total", "Paid", "Due"]],
      body: orders.map((o) => {
        const paid = Number(o.paid_amount ?? 0);
        const due = o.order_status === "Cancelled" ? 0 : Math.max(0, Number(o.due_amount ?? Number(o.total_amount) - paid));
        return [
          pdfText(o.order_number),
          pdfText(formatDate(o.placed_at)),
          pdfText(o.order_status),
          formatStatusLabel(o.payment_status),
          formatPdfMoney(o.total_amount, sym),
          formatPdfMoney(paid, sym),
          o.order_status === "Cancelled" ? "Void" : formatPdfMoney(due, sym),
        ];
      }),
      styles: { fontSize: 7.8, cellPadding: 4.5, overflow: "linebreak" },
      headStyles: { fillColor: [30, 64, 175], textColor: 255, fontStyle: "bold" },
      columnStyles: {
        0: { cellWidth: 88, fontStyle: "bold" },
        1: { cellWidth: 66 },
        2: { cellWidth: 105 },
        3: { cellWidth: 66 },
        4: { cellWidth: 68, halign: "right" },
        5: { cellWidth: 68, halign: "right" },
        6: { cellWidth: 70, halign: "right", fontStyle: "bold" },
      },
      margin: { top: TOP_NEXT_PAGE_Y, bottom: BOTTOM_FOOTER_RESERVE, left: MARGIN_X, right: MARGIN_X },
    });
    y = getLastTableEndY(doc, y + 50) + 16;
  }

  // Invoices & Payments
  y = drawSectionHeading(doc, y, `Invoices (${invoices.length}) & Payments (${payments.length})`);
  if (invoices.length === 0 && payments.length === 0) {
    y = drawMutedNote(doc, y, "No invoices or payment transactions recorded yet.");
  } else {
    if (invoices.length > 0) {
      autoTable(doc, {
        startY: y,
        tableWidth: PORTRAIT_TABLE_W,
        head: [["Invoice #", "Invoice Date", "Due Date", "Status", "Total", "Paid", "Balance"]],
        body: invoices.map((inv) => [
          pdfText(inv.invoice_number),
          pdfText(formatDate(inv.invoice_date)),
          pdfText(formatDate(inv.due_date)),
          formatStatusLabel(inv.payment_status),
          formatPdfMoney(inv.total_amount, sym),
          formatPdfMoney(inv.paid_amount, sym),
          formatPdfMoney(Math.max(0, Number(inv.total_amount) - Number(inv.paid_amount)), sym),
        ]),
        styles: { fontSize: 7.8, cellPadding: 4.5 },
        headStyles: { fillColor: [51, 65, 85], textColor: 255, fontStyle: "bold" },
        columnStyles: {
          0: { cellWidth: 95, fontStyle: "bold" },
          1: { cellWidth: 70 },
          2: { cellWidth: 70 },
          3: { cellWidth: 75 },
          4: { cellWidth: 73, halign: "right" },
          5: { cellWidth: 73, halign: "right" },
          6: { cellWidth: 75, halign: "right", fontStyle: "bold" },
        },
        margin: { top: TOP_NEXT_PAGE_Y, bottom: BOTTOM_FOOTER_RESERVE, left: MARGIN_X, right: MARGIN_X },
      });
      y = getLastTableEndY(doc, y + 50) + 14;
    }

    if (payments.length > 0) {
      autoTable(doc, {
        startY: y,
        tableWidth: PORTRAIT_TABLE_W,
        head: [["Date", "Invoice / Order Ref", "Method & Ref", "Amount", "Status", "Notes"]],
        body: payments.map((p) => [
          pdfText(formatDate(p.payment_date)),
          pdfText([p.invoice_number, p.order_number].filter(Boolean).join(" / "), "-"),
          `${pdfText(p.payment_method)}${p.reference_number ? ` (${pdfText(p.reference_number)})` : ""}`,
          formatPdfMoney(p.amount, sym),
          formatStatusLabel(p.status),
          pdfText(p.notes, "-"),
        ]),
        styles: { fontSize: 7.8, cellPadding: 4.5 },
        headStyles: { fillColor: [71, 85, 105], textColor: 255, fontStyle: "bold" },
        columnStyles: {
          0: { cellWidth: 65 },
          1: { cellWidth: 115 },
          2: { cellWidth: 120 },
          3: { cellWidth: 75, halign: "right", fontStyle: "bold" },
          4: { cellWidth: 55, halign: "center" },
          5: { cellWidth: 101 },
        },
        margin: { top: TOP_NEXT_PAGE_Y, bottom: BOTTOM_FOOTER_RESERVE, left: MARGIN_X, right: MARGIN_X },
      });
    }
  }

  addPageFooters(doc, `${agency.agency_name} - Customer Account Dossier (${customer.business_name})`);
  return doc;
}

export function generateCustomerDetailPdf(params: CustomerDetailPdfParams): void {
  const doc = buildCustomerDetailPdfDoc(params);
  const slug = pdfText(params.customer.business_name, "customer")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  doc.save(`customer-${slug || "profile"}-${toLocalDateString()}.pdf`);
}

export function buildAllManufacturersPdfDoc(params: AllManufacturersPdfParams): jsPDF {
  const { agency, ...data } = params;
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });
  const startY = drawDocumentHeader(doc, {
    agency,
    title: "ALL MANUFACTURERS & CATALOG PDF",
    subtitle: `${data.manufacturers.length} Manufacturers | ${data.products.length} SKUs | ${data.purchaseOrders.length} POs`,
    rightMeta: [`Exported: ${formatDateTime(new Date().toISOString())}`, "Internal Admin Cost & Margin Report"],
  });
  renderAllManufacturersSections(doc, agency, data, startY);
  addPageFooters(doc, `${agency.agency_name} - All Manufacturers, Product Costs & POs (Internal Confidential)`);
  return doc;
}

export function generateAllManufacturersPdf(params: AllManufacturersPdfParams): void {
  const doc = buildAllManufacturersPdfDoc(params);
  doc.save(`all-manufacturers-${toLocalDateString()}.pdf`);
}

export function buildManufacturerDetailPdfDoc(params: ManufacturerDetailPdfParams): jsPDF {
  const { agency, manufacturer, products, purchaseOrders } = params;
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });
  const startY = drawDocumentHeader(doc, {
    agency,
    title: "MANUFACTURER PROFILE & CATALOG",
    subtitle: manufacturer.company_name,
    rightMeta: [
      `Status: ${formatStatusLabel(manufacturer.status)}`,
      `Exported: ${formatDateTime(new Date().toISOString())}`,
    ],
  });
  renderAllManufacturersSections(
    doc,
    agency,
    { manufacturers: [manufacturer], products, purchaseOrders },
    startY
  );
  addPageFooters(doc, `${agency.agency_name} - Manufacturer Profile & Pricing (${manufacturer.company_name})`);
  return doc;
}

export function generateManufacturerDetailPdf(params: ManufacturerDetailPdfParams): void {
  const doc = buildManufacturerDetailPdfDoc(params);
  const slug = pdfText(params.manufacturer.company_name, "manufacturer")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  doc.save(`manufacturer-${slug || "profile"}-${toLocalDateString()}.pdf`);
}

export function buildAllOrdersDetailsPdfDoc(params: AllOrdersPdfParams): jsPDF {
  const { agency, ...data } = params;
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });
  const totalLines = data.entries.reduce((s, e) => s + e.items.length, 0);
  const startY = drawDocumentHeader(doc, {
    agency,
    title: "ALL ORDER DETAILS & FINANCIALS PDF",
    subtitle: `${data.entries.length} Orders | ${totalLines} Line Items | Payments, Costs, Margins & POs`,
    rightMeta: [`Exported: ${formatDateTime(new Date().toISOString())}`, "Internal Admin Confidential"],
  });
  renderAllOrdersSections(doc, agency, data, startY);
  addPageFooters(doc, `${agency.agency_name} - Complete Order Details, Internal Costing & Payments Report`);
  return doc;
}

export function generateAllOrdersDetailsPdf(params: AllOrdersPdfParams): void {
  const doc = buildAllOrdersDetailsPdfDoc(params);
  doc.save(`all-order-details-${toLocalDateString()}.pdf`);
}

export function buildAdminOrderDetailPdfDoc(params: AdminOrderDetailPdfParams): jsPDF {
  const { agency, entry } = params;
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });
  const startY = drawDocumentHeader(doc, {
    agency,
    title: `ORDER SHEET: ${entry.order.order_number}`,
    subtitle: `${entry.order.customers?.business_name || "Customer"} | ${entry.items.length} Line Item(s)`,
    rightMeta: [
      `Order Status: ${entry.order.order_status}`,
      `Exported: ${formatDateTime(new Date().toISOString())}`,
    ],
  });
  renderAllOrdersSections(doc, agency, { entries: [entry] }, startY);
  addPageFooters(doc, `${agency.agency_name} - Internal Order Sheet (${entry.order.order_number})`);
  return doc;
}

export function generateAdminOrderDetailPdf(params: AdminOrderDetailPdfParams): void {
  const doc = buildAdminOrderDetailPdfDoc(params);
  doc.save(`${pdfText(params.entry.order.order_number, "order-detail")}-internal.pdf`);
}

export function buildMasterBusinessDataPdfDoc(params: MasterBusinessDataPdfParams): jsPDF {
  const { agency, customersData, manufacturersData, ordersData } = params;
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });
  const sym = agency.currency_symbol || "₹";

  let y = drawDocumentHeader(doc, {
    agency,
    title: "COMPLETE BUSINESS DATA MASTER PDF",
    subtitle: "Customers, Manufacturers, Product Catalogs & Complete Order Details",
    rightMeta: [`Exported: ${formatDateTime(new Date().toISOString())}`, "Executive Internal Archive"],
  });

  const activeOrders = ordersData.entries.filter((e) => e.order.order_status !== "Cancelled");
  const totalOrderRev = activeOrders.reduce((s, e) => s + Number(e.order.total_amount ?? 0), 0);
  const totalPaid = activeOrders.reduce((s, e) => s + Number(e.order.paid_amount ?? 0), 0);
  const totalDue = activeOrders.reduce(
    (s, e) => s + Math.max(0, Number(e.order.due_amount ?? Number(e.order.total_amount) - Number(e.order.paid_amount ?? 0))),
    0
  );
  const totalMargin = activeOrders.reduce((s, e) => s + e.grossMarginTotal, 0);

  y = drawKpiStrip(doc, y, [
    {
      label: "Customers",
      value: String(customersData.customers.length),
      sub: `${customersData.addresses.length} Addresses | ${customersData.customPrices.length} Custom Prices`,
      tone: "blue",
    },
    {
      label: "Manufacturers & SKUs",
      value: `${manufacturersData.manufacturers.length} / ${manufacturersData.products.length}`,
      sub: `${manufacturersData.purchaseOrders.length} Total Purchase Orders`,
    },
    {
      label: "Orders (Active / Total)",
      value: `${activeOrders.length} / ${ordersData.entries.length}`,
      sub: `Revenue: ${formatPdfMoney(totalOrderRev, sym)}`,
    },
    {
      label: "Collections & Dues",
      value: formatPdfMoney(totalPaid, sym),
      sub: `Due: ${formatPdfMoney(totalDue, sym)}`,
      tone: totalDue > 0 ? "amber" : "green",
    },
    {
      label: "Realized Gross Margin",
      value: formatPdfSignedMoney(totalMargin, sym),
      sub: "Across active orders",
      tone: totalMargin < 0 ? "red" : "green",
    },
  ]);

  // Part 1: All Customers
  y = drawSectionHeading(doc, y, "PART 1: ALL CUSTOMERS DATA");
  renderAllCustomersSections(doc, agency, customersData, y);

  // Part 2: All Manufacturers & Catalogs
  doc.addPage();
  let yMfg = drawDocumentHeader(doc, {
    agency,
    title: "PART 2: ALL MANUFACTURERS & CATALOG",
    subtitle: `${manufacturersData.manufacturers.length} Manufacturers | ${manufacturersData.products.length} Products | ${manufacturersData.purchaseOrders.length} POs`,
  });
  renderAllManufacturersSections(doc, agency, manufacturersData, yMfg);

  // Part 3: All Order Details
  doc.addPage();
  let yOrd = drawDocumentHeader(doc, {
    agency,
    title: "PART 3: ALL ORDER DETAILS & FINANCIALS",
    subtitle: `${ordersData.entries.length} Orders | Complete Items, Costs, Margins, POs & Payments`,
  });
  renderAllOrdersSections(doc, agency, ordersData, yOrd);

  addPageFooters(doc, `${agency.agency_name} - Complete Business Data Master Backup PDF (Confidential)`);
  return doc;
}

export function generateMasterBusinessDataPdf(params: MasterBusinessDataPdfParams): void {
  const doc = buildMasterBusinessDataPdfDoc(params);
  doc.save(`tradebridge-complete-master-data-${toLocalDateString()}.pdf`);
}

export function buildAnalyticsReportPdfDoc(params: AnalyticsReportPdfParams): jsPDF {
  const { agency, reportTitle, dateRangeLabel, headers, rows, rightAlignedCols = [], summaryNotes = [] } = params;
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });

  let y = drawDocumentHeader(doc, {
    agency,
    title: `${reportTitle.toUpperCase()} REPORT`,
    subtitle: `Period: ${dateRangeLabel}  |  ${rows.length} Record(s)`,
    rightMeta: [`Exported: ${formatDateTime(new Date().toISOString())}`],
  });

  if (summaryNotes.length > 0) {
    y = drawSectionHeading(doc, y, reportTitle, summaryNotes.join("   |   "));
  }

  if (rows.length === 0) {
    drawMutedNote(doc, y, "No records matched the selected report criteria / date range.");
  } else {
    const colStyles: Record<number, { halign?: "left" | "center" | "right" }> = {};
    rightAlignedCols.forEach((colIdx) => {
      colStyles[colIdx] = { halign: "right" };
    });

    autoTable(doc, {
      startY: y,
      tableWidth: LANDSCAPE_TABLE_W,
      head: [headers.map((h) => pdfText(h))],
      body: rows.map((row) => row.map((cell) => pdfText(cell, "-"))),
      styles: { fontSize: 8, cellPadding: 5, textColor: [15, 23, 42], overflow: "linebreak" },
      headStyles: { fillColor: [30, 64, 175], textColor: 255, fontStyle: "bold" },
      alternateRowStyles: { fillColor: [250, 251, 252] },
      columnStyles: colStyles,
      margin: { top: TOP_NEXT_PAGE_Y, bottom: BOTTOM_FOOTER_RESERVE, left: MARGIN_X, right: MARGIN_X },
    });
  }

  addPageFooters(doc, `${agency.agency_name} - ${reportTitle} (${dateRangeLabel})`);
  return doc;
}

export function generateAnalyticsReportPdf(params: AnalyticsReportPdfParams): void {
  const doc = buildAnalyticsReportPdfDoc(params);
  doc.save(`tradebridge-${pdfText(params.reportKey, "report")}-${toLocalDateString()}.pdf`);
}
