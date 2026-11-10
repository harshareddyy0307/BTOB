import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { formatDate, formatQty } from "@/lib/utils";
import type {
  AgencySettings,
  CustomerProfile,
  InvoiceRecord,
  Manufacturer,
  OrderItemRecord,
  OrderRecord,
  PaymentRecord,
  PurchaseOrderItemRecord,
  PurchaseOrderRecord,
} from "@/types/database";

function formatPdfMoney(value: number | string | null | undefined, symbol = "₹"): string {
  const num = Number(value ?? 0);
  const safePrefix = symbol === "₹" ? "Rs. " : `${symbol} `;
  if (Number.isNaN(num)) return `${safePrefix}0.00`;
  return `${safePrefix}${num.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

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
  doc.text(agency.legal_name || agency.agency_name, 40, 32);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  const agencyMeta = [
    agency.gstin ? `GSTIN: ${agency.gstin}` : null,
    agency.pan ? `PAN: ${agency.pan}` : null,
    agency.phone ? `Tel: ${agency.phone}` : null,
  ]
    .filter(Boolean)
    .join("   |   ");
  if (agencyMeta) doc.text(agencyMeta, 40, 48);
  const addrLine = [agency.address, agency.city, agency.state, agency.pincode].filter(Boolean).join(", ");
  if (addrLine) doc.text(addrLine, 40, 62, { maxWidth: 340 });

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("PURCHASE ORDER", 555, 36, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(po.po_number, 555, 54, { align: "right" });

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
  doc.text(manufacturer.company_name, 40, y);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  const mfgLines = [
    `Attn: ${manufacturer.contact_person} (${manufacturer.phone})`,
    manufacturer.email ? `Email: ${manufacturer.email}` : null,
    manufacturer.gst_number ? `GSTIN: ${manufacturer.gst_number}` : null,
    [manufacturer.address, manufacturer.city, manufacturer.state].filter(Boolean).join(", "),
  ].filter(Boolean) as string[];
  doc.text(mfgLines, 40, y + 15, { maxWidth: 270 });

  const poMetaRows = [
    ["PO Number:", po.po_number],
    ["Issue Date:", formatDate(po.created_at)],
    ["Status:", po.status],
    ["Expected Delivery:", po.expected_delivery_date ? formatDate(po.expected_delivery_date) : "As per schedule"],
    ["Internal Order Ref:", sourceOrderNumber || "Stock Replenishment"],
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
      `${item.product_name_snapshot}\nSKU: ${item.sku_snapshot}`,
      item.unit_snapshot,
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

  const finalY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 360;
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
    doc.text(po.notes, 40, summaryY + 28, { maxWidth: 275 });
  }

  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139);
  doc.text(
    `Authorized Purchase Document issued by ${agency.agency_name}. Please reference ${po.po_number} on all challans & invoices.`,
    40,
    800
  );

  doc.save(`${po.po_number}.pdf`);
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
  doc.text(agency.legal_name || agency.agency_name, 40, 30);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  const taxIds = [
    agency.gstin ? `GSTIN: ${agency.gstin}` : null,
    agency.pan ? `PAN: ${agency.pan}` : null,
    agency.email ? `Email: ${agency.email}` : null,
  ]
    .filter(Boolean)
    .join("   |   ");
  if (taxIds) doc.text(taxIds, 40, 46);
  const fullAgencyAddr = [agency.address, agency.city, agency.state, agency.pincode, agency.phone ? `Tel: ${agency.phone}` : null]
    .filter(Boolean)
    .join(", ");
  if (fullAgencyAddr) doc.text(fullAgencyAddr, 40, 60, { maxWidth: 345 });

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("TAX INVOICE", 555, 34, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(invoice.invoice_number, 555, 52, { align: "right" });
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
  doc.text(customer.business_name, 40, y, { maxWidth: 165 });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  const billLines = [
    `Attn: ${customer.owner_name}`,
    `Tel: ${customer.phone}`,
    customer.gst_number ? `GSTIN: ${customer.gst_number}` : "GSTIN: Unregistered",
    [customer.business_address, customer.city, customer.state, customer.pincode].filter(Boolean).join(", "),
  ];
  doc.text(billLines, 40, y + 14, { maxWidth: 165 });

  const addr = order.delivery_address;
  const shipLines = [
    addr?.contact_name || customer.owner_name,
    addr?.contact_phone || customer.phone,
    [addr?.address_line, addr?.city, addr?.state, addr?.pincode].filter(Boolean).join(", "),
  ].filter(Boolean) as string[];
  doc.setFont("helvetica", "normal");
  doc.text(shipLines, 220, y, { maxWidth: 165 });

  const invMeta = [
    ["Invoice No:", invoice.invoice_number],
    ["Invoice Date:", formatDate(invoice.invoice_date)],
    ["Due Date:", formatDate(invoice.due_date)],
    ["Order Ref:", order.order_number],
    ["Pay Status:", invoice.payment_status.replace("_", " ").toUpperCase()],
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
      `${item.product_name_snapshot}\nSKU: ${item.sku_snapshot}`,
      item.hsn_snapshot || "—",
      `${formatQty(item.quantity)} ${item.unit_snapshot}`,
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

  const tableEndY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 360;
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
  doc.text(agency.bank_details || `Payable to ${agency.legal_name || agency.agency_name}`, 40, y2 + 26, { maxWidth: 270 });

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
        formatDate(p.payment_date),
        p.payment_method,
        p.reference_number || "—",
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
    doc.text(agency.terms_and_conditions, 40, 794, { maxWidth: 515 });
  }

  doc.save(`${invoice.invoice_number}.pdf`);
}
