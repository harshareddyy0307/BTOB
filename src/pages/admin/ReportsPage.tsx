import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as XLSX from "xlsx";
import { BarChart3, Download, FileSpreadsheet } from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { formatCurrency, formatDate, formatQty } from "@/lib/utils";
import type { AdminProduct, CustomerProfile, InvoiceRecord, PurchaseOrderRecord } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/shared/StatusBadge";

type ReportKey =
  | "daily_sales"
  | "monthly_sales"
  | "category_revenue"
  | "manufacturer_purchases"
  | "product_sales"
  | "customer_orders"
  | "gross_margins"
  | "outstanding_payments"
  | "inventory_status";

const REPORT_TABS: { key: ReportKey; label: string }[] = [
  { key: "daily_sales", label: "Daily Sales" },
  { key: "monthly_sales", label: "Monthly Sales" },
  { key: "category_revenue", label: "Category Revenue" },
  { key: "manufacturer_purchases", label: "Manufacturer Purchases" },
  { key: "product_sales", label: "Product Sales" },
  { key: "customer_orders", label: "Customer Orders" },
  { key: "gross_margins", label: "Gross Margins" },
  { key: "outstanding_payments", label: "Outstanding Payments" },
  { key: "inventory_status", label: "Inventory Status" },
];

interface ReportOrder {
  id: string;
  order_number: string;
  customer_id: string;
  subtotal: number;
  tax_total: number;
  total_amount: number;
  order_status: string;
  payment_status: string;
  placed_at: string;
  customers: { id: string; business_name: string; city: string | null; state: string } | null;
  order_items: {
    id: string;
    product_id: string;
    product_name_snapshot: string;
    sku_snapshot: string;
    quantity: number;
    unit_selling_price: number;
    line_total: number;
    order_item_financials:
      | {
          manufacturer_id: string;
          manufacturer_name_snapshot: string;
          unit_manufacturer_price: number;
          margin_amount_total: number;
        }
      | {
          manufacturer_id: string;
          manufacturer_name_snapshot: string;
          unit_manufacturer_price: number;
          margin_amount_total: number;
        }[]
      | null;
  }[];
}

export function ReportsPage() {
  const { branding } = useAuth();
  const sym = branding.currency_symbol || "₹";

  const [activeReport, setActiveReport] = useState<ReportKey>("daily_sales");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["admin-reports-dataset"],
    queryFn: async () => {
      const [ordersRes, posRes, invRes, prodRes, custRes] = await Promise.all([
        supabase
          .from("orders")
          .select(
            "id, order_number, customer_id, subtotal, tax_total, total_amount, order_status, payment_status, placed_at, customers(id, business_name, city, state), order_items(id, product_id, product_name_snapshot, sku_snapshot, quantity, unit_selling_price, line_total, order_item_financials(manufacturer_id, manufacturer_name_snapshot, unit_manufacturer_price, margin_amount_total))"
          )
          .order("placed_at", { ascending: false }),
        supabase
          .from("purchase_orders")
          .select("*, manufacturers(id, company_name)")
          .order("created_at", { ascending: false }),
        supabase
          .from("invoices")
          .select("*, customers(*), orders(order_number, order_status)")
          .order("due_date", { ascending: true }),
        supabase
          .from("products")
          .select("*, manufacturer:manufacturers(id, company_name), category:categories(id, name), inventory(*), product_prices(*)")
          .order("name"),
        supabase.from("customers").select("*").order("business_name"),
      ]);

      return {
        orders: (ordersRes.data ?? []) as unknown as ReportOrder[],
        purchaseOrders: (posRes.data ?? []) as unknown as PurchaseOrderRecord[],
        invoices: (invRes.data ?? []) as unknown as InvoiceRecord[],
        products: (prodRes.data ?? []) as unknown as AdminProduct[],
        customers: (custRes.data ?? []) as CustomerProfile[],
      };
    },
  });

  const applyPreset = (days: number | null) => {
    if (!days) {
      setFromDate("");
      setToDate("");
      return;
    }
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - days);
    setFromDate(start.toISOString().slice(0, 10));
    setToDate(end.toISOString().slice(0, 10));
  };

  const computed = useMemo(() => {
    const orders = (data?.orders ?? []).filter((o) => {
      if (o.order_status === "Cancelled") return false;
      const d = o.placed_at.slice(0, 10);
      if (fromDate && d < fromDate) return false;
      if (toDate && d > toDate) return false;
      return true;
    });

    const pos = (data?.purchaseOrders ?? []).filter((p) => {
      if (p.status === "Cancelled") return false;
      const d = p.created_at.slice(0, 10);
      if (fromDate && d < fromDate) return false;
      if (toDate && d > toDate) return false;
      return true;
    });

    const invoices = data?.invoices ?? [];
    const products = data?.products ?? [];
    const customers = data?.customers ?? [];

    const prodCatMap = new Map<string, string>();
    const prodMfgMap = new Map<string, string>();
    products.forEach((p) => {
      prodCatMap.set(p.id, p.category?.name || "Uncategorized");
      prodMfgMap.set(p.id, p.manufacturer?.company_name || "Unknown");
    });

    const extractFin = (item: ReportOrder["order_items"][number]) =>
      Array.isArray(item.order_item_financials) ? item.order_item_financials[0] : item.order_item_financials;

    // 1. Daily Sales
    const dailyMap = new Map<string, { date: string; orders: number; subtotal: number; gst: number; total_sales: number; gross_margin: number }>();
    // 2. Monthly Sales
    const monthlyMap = new Map<string, { month: string; orders: number; subtotal: number; gst: number; total_sales: number; gross_margin: number }>();
    // 3. Category Revenue
    const catMap = new Map<string, { category: string; units: number; revenue: number; mfg_cost: number; gross_margin: number }>();
    // 5. Product Sales
    const prodSalesMap = new Map<string, { product_name: string; sku: string; category: string; manufacturer: string; units_sold: number; revenue: number; mfg_cost: number; gross_margin: number }>();
    // 6. Customer Orders
    const custOrderMap = new Map<string, { business_name: string; city_state: string; order_count: number; total_ordered: number }>();
    // 7. Gross Margins
    const grossMarginRows: { order_number: string; date: string; customer: string; selling_total: number; mfg_cost: number; gross_margin: number; margin_pct: number }[] = [];

    for (const o of orders) {
      let orderMfgCost = 0;
      let orderMargin = 0;

      for (const item of o.order_items) {
        const fin = extractFin(item);
        const itemCost = Number(fin?.unit_manufacturer_price ?? 0) * Number(item.quantity);
        const itemMargin = Number(fin?.margin_amount_total ?? 0);
        orderMfgCost += itemCost;
        orderMargin += itemMargin;

        const cName = prodCatMap.get(item.product_id) || "Other";
        const catRow = catMap.get(cName) || { category: cName, units: 0, revenue: 0, mfg_cost: 0, gross_margin: 0 };
        catRow.units += Number(item.quantity);
        catRow.revenue += Number(item.line_total);
        catRow.mfg_cost += itemCost;
        catRow.gross_margin += itemMargin;
        catMap.set(cName, catRow);

        const pRow = prodSalesMap.get(item.product_id) || {
          product_name: item.product_name_snapshot,
          sku: item.sku_snapshot,
          category: cName,
          manufacturer: fin?.manufacturer_name_snapshot || prodMfgMap.get(item.product_id) || "—",
          units_sold: 0,
          revenue: 0,
          mfg_cost: 0,
          gross_margin: 0,
        };
        pRow.units_sold += Number(item.quantity);
        pRow.revenue += Number(item.line_total);
        pRow.mfg_cost += itemCost;
        pRow.gross_margin += itemMargin;
        prodSalesMap.set(item.product_id, pRow);
      }

      const dayKey = o.placed_at.slice(0, 10);
      const dRow = dailyMap.get(dayKey) || { date: dayKey, orders: 0, subtotal: 0, gst: 0, total_sales: 0, gross_margin: 0 };
      dRow.orders += 1;
      dRow.subtotal += Number(o.subtotal);
      dRow.gst += Number(o.tax_total);
      dRow.total_sales += Number(o.total_amount);
      dRow.gross_margin += orderMargin;
      dailyMap.set(dayKey, dRow);

      const mKey = o.placed_at.slice(0, 7);
      const mRow = monthlyMap.get(mKey) || { month: mKey, orders: 0, subtotal: 0, gst: 0, total_sales: 0, gross_margin: 0 };
      mRow.orders += 1;
      mRow.subtotal += Number(o.subtotal);
      mRow.gst += Number(o.tax_total);
      mRow.total_sales += Number(o.total_amount);
      mRow.gross_margin += orderMargin;
      monthlyMap.set(mKey, mRow);

      const bName = o.customers?.business_name || "Unknown";
      const cEntry = custOrderMap.get(o.customer_id) || {
        business_name: bName,
        city_state: [o.customers?.city, o.customers?.state].filter(Boolean).join(", "),
        order_count: 0,
        total_ordered: 0,
      };
      cEntry.order_count += 1;
      cEntry.total_ordered += Number(o.total_amount);
      custOrderMap.set(o.customer_id, cEntry);

      grossMarginRows.push({
        order_number: o.order_number,
        date: dayKey,
        customer: bName,
        selling_total: Number(o.subtotal),
        mfg_cost: Math.round(orderMfgCost * 100) / 100,
        gross_margin: Math.round(orderMargin * 100) / 100,
        margin_pct: orderMfgCost > 0 ? Math.round((orderMargin / orderMfgCost) * 1000) / 10 : 0,
      });
    }

    // Include customers with 0 orders if "All Time" (no date filter)
    if (!fromDate && !toDate) {
      customers.forEach((c) => {
        if (!custOrderMap.has(c.id)) {
          custOrderMap.set(c.id, {
            business_name: c.business_name,
            city_state: [c.city, c.state].filter(Boolean).join(", "),
            order_count: 0,
            total_ordered: 0,
          });
        }
      });
    }

    // 4. Manufacturer Purchases
    const mfgPoMap = new Map<string, { manufacturer: string; po_count: number; subtotal: number; tax: number; total_purchases: number; received_value: number }>();
    for (const po of pos) {
      const mName = po.manufacturers?.company_name || "Unknown";
      const row = mfgPoMap.get(po.manufacturer_id) || {
        manufacturer: mName,
        po_count: 0,
        subtotal: 0,
        tax: 0,
        total_purchases: 0,
        received_value: 0,
      };
      row.po_count += 1;
      row.subtotal += Number(po.subtotal);
      row.tax += Number(po.tax_total);
      row.total_purchases += Number(po.total_amount);
      if (po.status === "Received") row.received_value += Number(po.total_amount);
      mfgPoMap.set(po.manufacturer_id, row);
    }

    // 8. Outstanding Payments
    const todayMs = Date.now();
    const outstandingRows = invoices
      .filter((inv) => inv.payment_status !== "paid")
      .filter((inv) => {
        if (fromDate && inv.invoice_date < fromDate) return false;
        if (toDate && inv.invoice_date > toDate) return false;
        return true;
      })
      .map((inv) => {
        const balance = Math.max(0, Number(inv.total_amount) - Number(inv.paid_amount));
        const dueMs = new Date(inv.due_date).getTime();
        const daysOverdue = Math.max(0, Math.floor((todayMs - dueMs) / (1000 * 60 * 60 * 24)));
        return {
          invoice_number: inv.invoice_number,
          customer: inv.customers?.business_name || "—",
          order_number: inv.orders?.order_number || "—",
          invoice_date: inv.invoice_date,
          due_date: inv.due_date,
          days_overdue: daysOverdue,
          total_amount: Number(inv.total_amount),
          paid_amount: Number(inv.paid_amount),
          balance_due: Math.round(balance * 100) / 100,
          payment_status: inv.payment_status,
        };
      });

    // 9. Inventory Status
    const inventoryRows = products.map((p) => {
      const avail = Number(p.inventory?.available_quantity ?? 0);
      const reserved = Number(p.inventory?.reserved_quantity ?? 0);
      const sold = Number(p.inventory?.sold_quantity ?? 0);
      const thresh = Number(p.inventory?.low_stock_threshold ?? 10);
      const status = avail <= 0 ? "out_of_stock" : avail <= thresh ? "low_stock" : "in_stock";
      const costPrice = Number(p.product_prices?.draft_manufacturer_price ?? 0);
      return {
        product_name: p.name,
        sku: p.sku,
        category: p.category?.name || "—",
        manufacturer: p.manufacturer?.company_name || "—",
        available_qty: avail,
        reserved_qty: reserved,
        sold_qty: sold,
        unit: p.unit_of_measurement,
        stock_status: status,
        stock_cost_value: Math.round(avail * costPrice * 100) / 100,
      };
    });

    return {
      dailySales: Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
      monthlySales: Array.from(monthlyMap.values()).sort((a, b) => a.month.localeCompare(b.month)),
      categoryRevenue: Array.from(catMap.values()).sort((a, b) => b.revenue - a.revenue),
      manufacturerPurchases: Array.from(mfgPoMap.values()).sort((a, b) => b.total_purchases - a.total_purchases),
      productSales: Array.from(prodSalesMap.values()).sort((a, b) => b.revenue - a.revenue),
      customerOrders: Array.from(custOrderMap.values()).sort((a, b) => b.total_ordered - a.total_ordered),
      grossMargins: grossMarginRows,
      outstandingPayments: outstandingRows,
      inventoryStatus: inventoryRows,
    };
  }, [data, fromDate, toDate]);

  const getExportRows = (): Record<string, unknown>[] => {
    switch (activeReport) {
      case "daily_sales":
        return computed.dailySales;
      case "monthly_sales":
        return computed.monthlySales;
      case "category_revenue":
        return computed.categoryRevenue;
      case "manufacturer_purchases":
        return computed.manufacturerPurchases;
      case "product_sales":
        return computed.productSales;
      case "customer_orders":
        return computed.customerOrders;
      case "gross_margins":
        return computed.grossMargins;
      case "outstanding_payments":
        return computed.outstandingPayments;
      case "inventory_status":
        return computed.inventoryStatus;
    }
  };

  const handleExport = (format: "xlsx" | "csv") => {
    const rows = getExportRows();
    const ws = XLSX.utils.json_to_sheet(rows.length > 0 ? rows : [{ message: "No records" }]);
    const filename = `tradebridge-${activeReport}-${new Date().toISOString().slice(0, 10)}.${format}`;
    if (format === "csv") {
      const csv = XLSX.utils.sheet_to_csv(ws);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } else {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, activeReport.slice(0, 31));
      XLSX.writeFile(wb, filename);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-slate-900">
            <BarChart3 className="h-6 w-6 text-blue-700" />
            Reports &amp; Analytics
          </h1>
          <p className="text-sm text-slate-500">
            Real-time operational &amp; financial reports derived from Postgres records with CSV &amp; Excel exports.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => handleExport("csv")}>
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
          <Button size="sm" onClick={() => handleExport("xlsx")}>
            <FileSpreadsheet className="h-4 w-4" />
            Export Excel (.xlsx)
          </Button>
        </div>
      </div>

      {/* Date Filter Bar */}
      <Card>
        <CardContent className="flex flex-wrap items-end justify-between gap-4 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs">From Date</Label>
              <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="w-40" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">To Date</Label>
              <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="w-40" />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Button variant="outline" size="sm" onClick={() => applyPreset(30)}>
              Last 30 Days
            </Button>
            <Button variant="outline" size="sm" onClick={() => applyPreset(90)}>
              Last 90 Days
            </Button>
            <Button variant="outline" size="sm" onClick={() => applyPreset(365)}>
              12 Months
            </Button>
            <Button variant={!fromDate && !toDate ? "default" : "outline"} size="sm" onClick={() => applyPreset(null)}>
              All Time
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 9-Report Pill Selector */}
      <div className="flex flex-wrap gap-2">
        {REPORT_TABS.map((t) => (
          <Button
            key={t.key}
            size="sm"
            variant={activeReport === t.key ? "default" : "outline"}
            onClick={() => setActiveReport(t.key)}
          >
            {t.label}
          </Button>
        ))}
      </div>

      {isLoading ? (
        <div className="py-12 text-center text-sm text-slate-500">Compiling report from database...</div>
      ) : (
        <div className="space-y-6">
          {/* Chart Panels for Key Financial Views */}
          {activeReport === "daily_sales" && computed.dailySales.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Daily Sales Trend</CardTitle>
              </CardHeader>
              <CardContent className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={computed.dailySales}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#64748b" }} />
                    <YAxis tick={{ fontSize: 11, fill: "#64748b" }} />
                    <Tooltip formatter={(val: number) => formatCurrency(val, sym)} />
                    <Area type="monotone" dataKey="total_sales" name="Sales" stroke="#1d4ed8" fill="#dbeafe" strokeWidth={2} />
                    <Area type="monotone" dataKey="gross_margin" name="Margin" stroke="#047857" fill="#d1fae5" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}

          {activeReport === "monthly_sales" && computed.monthlySales.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Monthly Revenue vs Gross Margin</CardTitle>
              </CardHeader>
              <CardContent className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={computed.monthlySales}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#64748b" }} />
                    <YAxis tick={{ fontSize: 11, fill: "#64748b" }} />
                    <Tooltip formatter={(val: number) => formatCurrency(val, sym)} />
                    <Bar dataKey="total_sales" name="Total Sales" fill="#1e40af" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="gross_margin" name="Gross Margin" fill="#059669" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}

          {activeReport === "category_revenue" && computed.categoryRevenue.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Category-wise Revenue Comparison</CardTitle>
              </CardHeader>
              <CardContent className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={computed.categoryRevenue}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="category" tick={{ fontSize: 11, fill: "#64748b" }} />
                    <YAxis tick={{ fontSize: 11, fill: "#64748b" }} />
                    <Tooltip formatter={(val: number) => formatCurrency(val, sym)} />
                    <Bar dataKey="revenue" name="Revenue" fill="#0f766e" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}

          {/* Active Data Table */}
          <Card>
            <CardHeader>
              <CardTitle>{REPORT_TABS.find((r) => r.key === activeReport)?.label} Report</CardTitle>
              <CardDescription>Live database breakdown ({getExportRows().length} rows)</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {activeReport === "daily_sales" && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Orders</TableHead>
                      <TableHead>Taxable Subtotal</TableHead>
                      <TableHead>GST Total</TableHead>
                      <TableHead>Total Sales</TableHead>
                      <TableHead className="text-right">Gross Margin</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {computed.dailySales.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="py-8 text-center text-slate-500">
                          No sales recorded in selected date range.
                        </TableCell>
                      </TableRow>
                    ) : (
                      computed.dailySales.map((r) => (
                        <TableRow key={r.date}>
                          <TableCell className="font-medium">{formatDate(r.date)}</TableCell>
                          <TableCell>{r.orders}</TableCell>
                          <TableCell>{formatCurrency(r.subtotal, sym)}</TableCell>
                          <TableCell>{formatCurrency(r.gst, sym)}</TableCell>
                          <TableCell className="font-semibold">{formatCurrency(r.total_sales, sym)}</TableCell>
                          <TableCell className="text-right font-semibold text-emerald-700">
                            {formatCurrency(r.gross_margin, sym)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              )}

              {activeReport === "monthly_sales" && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Month</TableHead>
                      <TableHead>Orders</TableHead>
                      <TableHead>Taxable Subtotal</TableHead>
                      <TableHead>GST Total</TableHead>
                      <TableHead>Total Sales</TableHead>
                      <TableHead className="text-right">Gross Margin</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {computed.monthlySales.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="py-8 text-center text-slate-500">
                          No monthly sales data for selected range.
                        </TableCell>
                      </TableRow>
                    ) : (
                      computed.monthlySales.map((r) => (
                        <TableRow key={r.month}>
                          <TableCell className="font-semibold">{r.month}</TableCell>
                          <TableCell>{r.orders}</TableCell>
                          <TableCell>{formatCurrency(r.subtotal, sym)}</TableCell>
                          <TableCell>{formatCurrency(r.gst, sym)}</TableCell>
                          <TableCell className="font-semibold">{formatCurrency(r.total_sales, sym)}</TableCell>
                          <TableCell className="text-right font-semibold text-emerald-700">
                            {formatCurrency(r.gross_margin, sym)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              )}

              {activeReport === "category_revenue" && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Category</TableHead>
                      <TableHead>Units Ordered</TableHead>
                      <TableHead>Customer Revenue</TableHead>
                      <TableHead>Mfg Cost</TableHead>
                      <TableHead className="text-right">Gross Margin</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {computed.categoryRevenue.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="py-8 text-center text-slate-500">
                          No category sales in selected range.
                        </TableCell>
                      </TableRow>
                    ) : (
                      computed.categoryRevenue.map((r) => (
                        <TableRow key={r.category}>
                          <TableCell className="font-semibold">{r.category}</TableCell>
                          <TableCell>{formatQty(r.units)}</TableCell>
                          <TableCell className="font-semibold">{formatCurrency(r.revenue, sym)}</TableCell>
                          <TableCell>{formatCurrency(r.mfg_cost, sym)}</TableCell>
                          <TableCell className="text-right font-semibold text-emerald-700">
                            {formatCurrency(r.gross_margin, sym)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              )}

              {activeReport === "manufacturer_purchases" && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Manufacturer</TableHead>
                      <TableHead>PO Count</TableHead>
                      <TableHead>PO Subtotal</TableHead>
                      <TableHead>Input GST</TableHead>
                      <TableHead>Total PO Value</TableHead>
                      <TableHead className="text-right">Received Goods Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {computed.manufacturerPurchases.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="py-8 text-center text-slate-500">
                          No manufacturer purchase orders recorded.
                        </TableCell>
                      </TableRow>
                    ) : (
                      computed.manufacturerPurchases.map((r) => (
                        <TableRow key={r.manufacturer}>
                          <TableCell className="font-semibold">{r.manufacturer}</TableCell>
                          <TableCell>{r.po_count}</TableCell>
                          <TableCell>{formatCurrency(r.subtotal, sym)}</TableCell>
                          <TableCell>{formatCurrency(r.tax, sym)}</TableCell>
                          <TableCell className="font-semibold">{formatCurrency(r.total_purchases, sym)}</TableCell>
                          <TableCell className="text-right text-emerald-700 font-semibold">
                            {formatCurrency(r.received_value, sym)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              )}

              {activeReport === "product_sales" && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product / SKU</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Manufacturer</TableHead>
                      <TableHead>Units Sold</TableHead>
                      <TableHead>Sales Revenue</TableHead>
                      <TableHead className="text-right">Gross Margin</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {computed.productSales.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="py-8 text-center text-slate-500">
                          No product sales recorded in selected range.
                        </TableCell>
                      </TableRow>
                    ) : (
                      computed.productSales.map((r) => (
                        <TableRow key={r.sku}>
                          <TableCell>
                            <p className="font-medium text-slate-900">{r.product_name}</p>
                            <p className="font-mono text-xs text-slate-500">{r.sku}</p>
                          </TableCell>
                          <TableCell className="text-xs">{r.category}</TableCell>
                          <TableCell className="text-xs">{r.manufacturer}</TableCell>
                          <TableCell>{formatQty(r.units_sold)}</TableCell>
                          <TableCell className="font-semibold">{formatCurrency(r.revenue, sym)}</TableCell>
                          <TableCell className="text-right font-semibold text-emerald-700">
                            {formatCurrency(r.gross_margin, sym)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              )}

              {activeReport === "customer_orders" && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Customer Business</TableHead>
                      <TableHead>City / State</TableHead>
                      <TableHead>Orders Placed</TableHead>
                      <TableHead className="text-right">Total Ordered Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {computed.customerOrders.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} className="py-8 text-center text-slate-500">
                          No customer order activity found.
                        </TableCell>
                      </TableRow>
                    ) : (
                      computed.customerOrders.map((r) => (
                        <TableRow key={r.business_name}>
                          <TableCell className="font-semibold">{r.business_name}</TableCell>
                          <TableCell className="text-xs text-slate-500">{r.city_state || "—"}</TableCell>
                          <TableCell>{r.order_count}</TableCell>
                          <TableCell className="text-right font-semibold">{formatCurrency(r.total_ordered, sym)}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              )}

              {activeReport === "gross_margins" && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Order #</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead>Taxable Sales</TableHead>
                      <TableHead>Mfg Cost</TableHead>
                      <TableHead>Margin Amt</TableHead>
                      <TableHead className="text-right">Margin %</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {computed.grossMargins.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="py-8 text-center text-slate-500">
                          No order margin records in selected range.
                        </TableCell>
                      </TableRow>
                    ) : (
                      computed.grossMargins.map((r) => (
                        <TableRow key={r.order_number}>
                          <TableCell className="font-mono font-semibold">{r.order_number}</TableCell>
                          <TableCell className="text-xs text-slate-500">{formatDate(r.date)}</TableCell>
                          <TableCell>{r.customer}</TableCell>
                          <TableCell>{formatCurrency(r.selling_total, sym)}</TableCell>
                          <TableCell>{formatCurrency(r.mfg_cost, sym)}</TableCell>
                          <TableCell className="font-semibold text-emerald-700">{formatCurrency(r.gross_margin, sym)}</TableCell>
                          <TableCell className="text-right font-semibold">{r.margin_pct}%</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              )}

              {activeReport === "outstanding_payments" && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Invoice #</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead>Due Date</TableHead>
                      <TableHead>Days Overdue</TableHead>
                      <TableHead>Total</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Balance Due</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {computed.outstandingPayments.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="py-8 text-center text-slate-500">
                          Zero outstanding customer dues.
                        </TableCell>
                      </TableRow>
                    ) : (
                      computed.outstandingPayments.map((r) => (
                        <TableRow key={r.invoice_number}>
                          <TableCell className="font-semibold">{r.invoice_number}</TableCell>
                          <TableCell>{r.customer}</TableCell>
                          <TableCell className="text-xs text-slate-500">{formatDate(r.due_date)}</TableCell>
                          <TableCell className={r.days_overdue > 0 ? "font-semibold text-red-700" : "text-xs text-slate-500"}>
                            {r.days_overdue > 0 ? `${r.days_overdue} days` : "Current"}
                          </TableCell>
                          <TableCell>{formatCurrency(r.total_amount, sym)}</TableCell>
                          <TableCell>
                            <StatusBadge status={r.payment_status} />
                          </TableCell>
                          <TableCell className="text-right font-bold text-red-700">
                            {formatCurrency(r.balance_due, sym)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              )}

              {activeReport === "inventory_status" && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product / SKU</TableHead>
                      <TableHead>Manufacturer</TableHead>
                      <TableHead>Available</TableHead>
                      <TableHead>Reserved</TableHead>
                      <TableHead>Sold</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Stock Cost Valuation</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {computed.inventoryStatus.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="py-8 text-center text-slate-500">
                          No inventory SKUs found.
                        </TableCell>
                      </TableRow>
                    ) : (
                      computed.inventoryStatus.map((r) => (
                        <TableRow key={r.sku}>
                          <TableCell>
                            <p className="font-medium text-slate-900">{r.product_name}</p>
                            <p className="font-mono text-xs text-slate-500">
                              {r.sku} &bull; {r.category}
                            </p>
                          </TableCell>
                          <TableCell className="text-xs">{r.manufacturer}</TableCell>
                          <TableCell className="font-semibold">
                            {formatQty(r.available_qty)} {r.unit}
                          </TableCell>
                          <TableCell className="text-xs">{formatQty(r.reserved_qty)}</TableCell>
                          <TableCell className="text-xs">{formatQty(r.sold_qty)}</TableCell>
                          <TableCell>
                            <StatusBadge status={r.stock_status} />
                          </TableCell>
                          <TableCell className="text-right font-semibold">
                            {formatCurrency(r.stock_cost_value, sym)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
