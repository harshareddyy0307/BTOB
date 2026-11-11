import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Factory,
  Building2,
  Package,
  CheckCircle2,
  FolderTree,
  ShoppingCart,
  Clock,
  IndianRupee,
  TrendingUp,
  ArrowRight,
} from "lucide-react";
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
import { formatSignedCurrency } from "@/lib/pricing";
import { cn, formatCurrency, formatDate, formatQty } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/shared/StatusBadge";

export function AdminDashboardPage() {
  const { branding } = useAuth();
  const sym = branding.currency_symbol || "₹";

  const { data, isLoading } = useQuery({
    queryKey: ["admin-dashboard-stats"],
    queryFn: async () => {
      const [
        mfgRes,
        custRes,
        pendingCustRes,
        prodRes,
        catRes,
        ordersRes,
        orderItemsRes,
        financialsRes,
        recentMfgRes,
      ] = await Promise.all([
        supabase.from("manufacturers").select("id", { count: "exact", head: true }),
        supabase.from("customers").select("id", { count: "exact", head: true }),
        supabase.from("customers").select("id", { count: "exact", head: true }).eq("status", "pending"),
        supabase.from("products").select("id, status, category_id, name, categories(name)"),
        supabase.from("categories").select("id", { count: "exact", head: true }),
        supabase
          .from("orders")
          .select("id, order_number, total_amount, paid_amount, due_amount, order_status, payment_status, placed_at, customers(business_name)")
          .order("placed_at", { ascending: false }),
        supabase.from("order_items").select("order_id, product_id, product_name_snapshot, quantity, line_total"),
        supabase.from("order_item_financials").select("order_item_id, margin_amount_total, order_items!inner(order_id)"),
        supabase
          .from("manufacturers")
          .select("id, company_name, contact_person, status, updated_at")
          .order("updated_at", { ascending: false })
          .limit(5),
      ]);

      const products = prodRes.data ?? [];
      const orders = ordersRes.data ?? [];
      const orderItems = orderItemsRes.data ?? [];
      const financials = financialsRes.data ?? [];

      const todayIso = new Date().toISOString().slice(0, 10);
      const nonCancelledOrders = orders.filter((o) => o.order_status !== "Cancelled");
      const nonCancelledIds = new Set(nonCancelledOrders.map((o) => o.id));

      const todaysOrders = orders.filter((o) => o.placed_at.slice(0, 10) === todayIso).length;
      const pendingOrders = orders.filter((o) =>
        ["Pending", "Confirmed", "Processing", "Purchase Order Sent", "Manufacturer Fulfilment Pending"].includes(
          o.order_status
        )
      ).length;
      const completedOrders = orders.filter((o) => o.order_status === "Delivered").length;

      const totalSales = nonCancelledOrders.reduce((acc, o) => acc + Number(o.total_amount || 0), 0);
      const totalCollected = nonCancelledOrders.reduce((acc, o) => acc + Number(o.paid_amount || 0), 0);
      const totalDue = nonCancelledOrders.reduce(
        (acc, o) => acc + Math.max(0, Number(o.due_amount ?? Number(o.total_amount || 0) - Number(o.paid_amount || 0))),
        0
      );
      const estimatedGrossMargin = financials.reduce((acc, f) => {
        const oid = (f.order_items as unknown as { order_id: string })?.order_id;
        return nonCancelledIds.has(oid) ? acc + Number(f.margin_amount_total || 0) : acc;
      }, 0);

      // Daily sales (last 14 days from actual orders)
      const dailyMap = new Map<string, number>();
      for (let i = 13; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        dailyMap.set(d.toISOString().slice(0, 10), 0);
      }
      for (const o of nonCancelledOrders) {
        const key = o.placed_at.slice(0, 10);
        if (dailyMap.has(key)) {
          dailyMap.set(key, (dailyMap.get(key) || 0) + Number(o.total_amount || 0));
        }
      }
      const dailySalesChart = Array.from(dailyMap.entries()).map(([date, sales]) => ({
        date: date.slice(5),
        sales: Math.round(sales * 100) / 100,
      }));

      // Monthly revenue (last 6 months from actual orders)
      const monthlyMap = new Map<string, number>();
      for (let i = 5; i >= 0; i--) {
        const d = new Date();
        d.setMonth(d.getMonth() - i);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        monthlyMap.set(key, 0);
      }
      for (const o of nonCancelledOrders) {
        const key = o.placed_at.slice(0, 7);
        if (monthlyMap.has(key)) {
          monthlyMap.set(key, (monthlyMap.get(key) || 0) + Number(o.total_amount || 0));
        }
      }
      const monthlyRevenueChart = Array.from(monthlyMap.entries()).map(([month, revenue]) => ({
        month,
        revenue: Math.round(revenue * 100) / 100,
      }));

      // Top selling products + Category sales
      const productCatMap = new Map<string, string>();
      for (const p of products) {
        const cname = (p.categories as unknown as { name: string })?.name || "Uncategorized";
        productCatMap.set(p.id, cname);
      }

      const topProdMap = new Map<string, { id: string; name: string; qty: number; revenue: number }>();
      const catSalesMap = new Map<string, number>();

      for (const item of orderItems) {
        if (!nonCancelledIds.has(item.order_id)) continue;
        const prev = topProdMap.get(item.product_id) || {
          id: item.product_id,
          name: item.product_name_snapshot,
          qty: 0,
          revenue: 0,
        };
        prev.qty += Number(item.quantity || 0);
        prev.revenue += Number(item.line_total || 0);
        topProdMap.set(item.product_id, prev);

        const catName = productCatMap.get(item.product_id) || "Other";
        catSalesMap.set(catName, (catSalesMap.get(catName) || 0) + Number(item.line_total || 0));
      }

      const topProducts = Array.from(topProdMap.values())
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 5);

      const categorySales = Array.from(catSalesMap.entries())
        .map(([category, sales]) => ({ category, sales: Math.round(sales * 100) / 100 }))
        .sort((a, b) => b.sales - a.sales)
        .slice(0, 8);

      return {
        totalManufacturers: mfgRes.count ?? 0,
        totalCustomers: custRes.count ?? 0,
        pendingCustomers: pendingCustRes.count ?? 0,
        totalProducts: products.length,
        activeProducts: products.filter((p) => p.status === "active").length,
        totalCategories: catRes.count ?? 0,
        todaysOrders,
        pendingOrders,
        completedOrders,
        totalSales,
        totalCollected,
        totalDue,
        estimatedGrossMargin,
        dailySalesChart,
        monthlyRevenueChart,
        recentOrders: orders.slice(0, 6),
        recentManufacturers: recentMfgRes.data ?? [],
        topProducts,
        categorySales,
      };
    },
  });

  const kpis = [
    { label: "Total Manufacturers", value: data?.totalManufacturers ?? 0, icon: Factory, to: "/admin/manufacturers" },
    { label: "Registered Businesses", value: data?.totalCustomers ?? 0, icon: Building2, to: "/admin/customers" },
    { label: "Total Products", value: data?.totalProducts ?? 0, icon: Package, to: "/admin/products" },
    { label: "Active Products", value: data?.activeProducts ?? 0, icon: CheckCircle2, to: "/admin/products" },
    { label: "Total Categories", value: data?.totalCategories ?? 0, icon: FolderTree, to: "/admin/categories" },
    { label: "Today's Orders", value: data?.todaysOrders ?? 0, icon: ShoppingCart, to: "/admin/operations" },
    { label: "Pending Orders", value: data?.pendingOrders ?? 0, icon: Clock, to: "/admin/operations" },
    { label: "Completed Orders", value: data?.completedOrders ?? 0, icon: CheckCircle2, to: "/admin/orders" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Executive Dashboard</h1>
          <p className="text-sm text-slate-500">
            Live database metrics across manufacturers, catalog pricing, orders, and margins.
          </p>
        </div>
        <Link
          to="/admin/operations"
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-primary/90"
        >
          Open Daily Operations
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>

      {(data?.pendingCustomers ?? 0) > 0 && (
        <Link
          to="/admin/customers?status=pending"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 transition-colors hover:bg-amber-100/80"
        >
          <div className="flex items-center gap-2.5">
            <Clock className="h-5 w-5 shrink-0 text-amber-700" />
            <span>
              <strong>{data?.pendingCustomers}</strong> customer business{" "}
              {data?.pendingCustomers === 1 ? "registration is" : "registrations are"} waiting for access approval.
            </span>
          </div>
          <span className="inline-flex items-center gap-1 font-semibold text-amber-900">
            Review &amp; Grant Access
            <ArrowRight className="h-4 w-4" />
          </span>
        </Link>
      )}

      {/* Financial Summary Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="flex items-center justify-between p-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Total Sales (Gross)</p>
              <p className="mt-1 text-3xl font-bold text-slate-900">
                {isLoading ? "—" : formatCurrency(data?.totalSales ?? 0, sym)}
              </p>
              <p className="mt-1 text-xs text-slate-500">Sum of non-cancelled B2B orders</p>
            </div>
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
              <IndianRupee className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center justify-between p-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Estimated Gross Margin</p>
              <p
                className={cn(
                  "mt-1 text-3xl font-bold",
                  (data?.estimatedGrossMargin ?? 0) < 0 ? "text-red-700" : "text-emerald-700"
                )}
              >
                {isLoading ? "—" : formatSignedCurrency(data?.estimatedGrossMargin ?? 0, sym)}
              </p>
              <p className="mt-1 text-xs text-slate-500">Net agency margin from order price snapshots</p>
            </div>
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700">
              <TrendingUp className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>

        <Link to="/admin/orders">
          <Card className="h-full transition-colors hover:border-red-300">
            <CardContent className="flex items-center justify-between p-5">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Customer Amount Due</p>
                <p className="mt-1 text-3xl font-bold text-red-700">
                  {isLoading ? "—" : formatCurrency(data?.totalDue ?? 0, sym)}
                </p>
                <p className="mt-1 text-xs text-emerald-700 font-medium">
                  Collected: {isLoading ? "—" : formatCurrency(data?.totalCollected ?? 0, sym)}
                </p>
              </div>
              <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-red-50 text-red-700">
                <Clock className="h-5 w-5" />
              </div>
            </CardContent>
          </Card>
        </Link>
      </div>

      {/* Operational KPI Grid */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {kpis.map((kpi) => {
          const Icon = kpi.icon;
          return (
            <Link key={kpi.label} to={kpi.to}>
              <Card className="transition-colors hover:border-blue-300">
                <CardContent className="flex items-center justify-between p-4">
                  <div>
                    <p className="text-xs font-medium text-slate-500">{kpi.label}</p>
                    <p className="mt-1 text-2xl font-bold text-slate-900">{isLoading ? "—" : kpi.value}</p>
                  </div>
                  <Icon className="h-5 w-5 text-slate-400" />
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>

      {/* Charts */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Daily Sales (Last 14 Days)</CardTitle>
          </CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data?.dailySalesChart ?? []}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#64748b" }} />
                <YAxis tick={{ fontSize: 11, fill: "#64748b" }} />
                <Tooltip formatter={(val: number) => formatCurrency(val, sym)} />
                <Area type="monotone" dataKey="sales" stroke="#1d4ed8" fill="#dbeafe" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Monthly Revenue (Last 6 Months)</CardTitle>
          </CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data?.monthlyRevenueChart ?? []}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#64748b" }} />
                <YAxis tick={{ fontSize: 11, fill: "#64748b" }} />
                <Tooltip formatter={(val: number) => formatCurrency(val, sym)} />
                <Bar dataKey="revenue" fill="#1e40af" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Category Sales & Top Products */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Category-wise Sales Performance</CardTitle>
          </CardHeader>
          <CardContent>
            {!data?.categorySales.length ? (
              <p className="py-8 text-center text-sm text-slate-500">No order sales recorded yet.</p>
            ) : (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.categorySales} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis type="number" tick={{ fontSize: 11, fill: "#64748b" }} />
                    <YAxis type="category" dataKey="category" width={120} tick={{ fontSize: 11, fill: "#334155" }} />
                    <Tooltip formatter={(val: number) => formatCurrency(val, sym)} />
                    <Bar dataKey="sales" fill="#0f766e" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top-Selling Products</CardTitle>
          </CardHeader>
          <CardContent>
            {!data?.topProducts.length ? (
              <p className="py-8 text-center text-sm text-slate-500">No products sold yet.</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {data.topProducts.map((p, idx) => (
                  <div key={p.id} className="flex items-center justify-between py-3">
                    <div>
                      <p className="text-sm font-medium text-slate-900">
                        {idx + 1}. {p.name}
                      </p>
                      <p className="text-xs text-slate-500">{formatQty(p.qty)} units ordered</p>
                    </div>
                    <p className="text-sm font-semibold text-slate-900">{formatCurrency(p.revenue, sym)}</p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Recent Orders & Recent Manufacturer Updates */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Recent Orders</CardTitle>
            <Link to="/admin/orders" className="text-xs font-medium text-blue-700 hover:underline">
              View all
            </Link>
          </CardHeader>
          <CardContent>
            {!data?.recentOrders.length ? (
              <p className="py-8 text-center text-sm text-slate-500">No orders placed yet.</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {data.recentOrders.map((o) => (
                  <Link
                    key={o.id}
                    to={`/admin/orders/${o.id}`}
                    className="flex items-center justify-between py-3 hover:bg-slate-50/70"
                  >
                    <div>
                      <p className="text-sm font-semibold text-slate-900">{o.order_number}</p>
                      <p className="text-xs text-slate-500">
                        {(o.customers as unknown as { business_name: string })?.business_name} &bull;{" "}
                        {formatDate(o.placed_at)}
                        {o.order_status !== "Cancelled" && Number(o.due_amount ?? 0) > 0
                          ? ` • Due ${formatCurrency(o.due_amount, sym)}`
                          : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={o.order_status} />
                      <StatusBadge status={o.payment_status} />
                      <span className="text-sm font-semibold text-slate-900">
                        {formatCurrency(o.total_amount, sym)}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Recent Manufacturer Updates</CardTitle>
            <Link to="/admin/manufacturers" className="text-xs font-medium text-blue-700 hover:underline">
              View directory
            </Link>
          </CardHeader>
          <CardContent>
            {!data?.recentManufacturers.length ? (
              <p className="py-8 text-center text-sm text-slate-500">No manufacturers added yet.</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {data.recentManufacturers.map((m) => (
                  <Link
                    key={m.id}
                    to={`/admin/manufacturers/${m.id}`}
                    className="flex items-center justify-between py-3 hover:bg-slate-50/70"
                  >
                    <div>
                      <p className="text-sm font-semibold text-slate-900">{m.company_name}</p>
                      <p className="text-xs text-slate-500">
                        Contact: {m.contact_person} &bull; Updated {formatDate(m.updated_at)}
                      </p>
                    </div>
                    <StatusBadge status={m.status} />
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
