import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Search, ArrowRight, LayoutGrid, Package, Truck } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { Category, CustomerCatalogProduct, OrderRecord } from "@/types/database";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { CustomerProductCard } from "@/components/customer/CustomerProductCard";

export function CustomerHomePage() {
  const { customerProfile } = useAuth();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState("");

  const { data: categories = [] } = useQuery({
    queryKey: ["customer-categories"],
    queryFn: async () => {
      const { data } = await supabase
        .from("categories")
        .select("*")
        .eq("status", "active")
        .is("parent_id", null)
        .order("sort_order")
        .limit(8);
      return (data ?? []) as Category[];
    },
  });

  const { data: catalog = [] } = useQuery({
    queryKey: ["customer-home-catalog", customerProfile?.id],
    enabled: Boolean(customerProfile?.id),
    queryFn: async () => {
      const { data } = await supabase
        .from("v_customer_catalog")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(24);
      return (data ?? []) as CustomerCatalogProduct[];
    },
  });

  const { data: currentOrders = [] } = useQuery({
    queryKey: ["customer-active-orders", customerProfile?.id],
    enabled: Boolean(customerProfile?.id),
    queryFn: async () => {
      const { data } = await supabase
        .from("orders")
        .select("*")
        .eq("customer_id", customerProfile!.id)
        .not("order_status", "in", '("Delivered","Cancelled")')
        .order("placed_at", { ascending: false })
        .limit(4);
      return (data ?? []) as OrderRecord[];
    },
  });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    navigate(searchQuery.trim() ? `/customer/products?q=${encodeURIComponent(searchQuery.trim())}` : "/customer/products");
  };

  const featuredProducts = catalog.filter((p) => p.is_featured).slice(0, 4);
  const recentProducts = catalog.slice(0, 4);
  const popularProducts = catalog.filter((p) => p.stock_status === "in_stock").slice(0, 4);

  return (
    <div className="space-y-8">
      {/* Welcome & Search Banner */}
      <Card className="border-slate-200 bg-white">
        <CardContent className="p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-blue-700">Wholesale Ordering Portal</p>
              <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
                Welcome back, {customerProfile?.business_name}
              </h1>
              <p className="mt-1 text-sm text-slate-500">
                Browse verified wholesale stock, place bulk orders, and track active deliveries in real time.
              </p>
            </div>
            <form onSubmit={handleSearch} className="flex w-full gap-2 lg:w-96">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search SKU or product..."
                  className="pl-9"
                />
              </div>
              <Button type="submit">Search</Button>
            </form>
          </div>
        </CardContent>
      </Card>

      {/* Current Orders */}
      {currentOrders.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Truck className="h-4 w-4 text-blue-700" />
              Active Orders ({currentOrders.length})
            </CardTitle>
            <Link to="/customer/orders" className="text-xs font-medium text-blue-700 hover:underline">
              View all orders
            </Link>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {currentOrders.map((o) => (
              <Link
                key={o.id}
                to={`/customer/orders/${o.id}`}
                className="flex items-center justify-between rounded-md border border-slate-200 p-3 hover:border-blue-300"
              >
                <div>
                  <p className="text-sm font-semibold text-slate-900">{o.order_number}</p>
                  <p className="text-xs text-slate-500">Placed {formatDate(o.placed_at)}</p>
                </div>
                <div className="space-y-1 text-right">
                  <div className="flex items-center justify-end gap-1.5">
                    <StatusBadge status={o.order_status} />
                    <StatusBadge status={o.payment_status} />
                  </div>
                  <p className="text-xs font-semibold text-slate-800">{formatCurrency(o.total_amount)}</p>
                  {Number(o.due_amount ?? Number(o.total_amount) - Number(o.paid_amount ?? 0)) > 0 && (
                    <p className="text-[11px] font-semibold text-red-700">
                      Due: {formatCurrency(Number(o.due_amount ?? Number(o.total_amount) - Number(o.paid_amount ?? 0)))}
                    </p>
                  )}
                </div>
              </Link>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Product Categories */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900">
            <LayoutGrid className="h-4 w-4 text-blue-700" />
            Browse Categories
          </h2>
          <Link to="/customer/categories" className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline">
            All Categories <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {categories.map((cat) => (
            <Link key={cat.id} to={`/customer/categories/${cat.id}`}>
              <Card className="transition-colors hover:border-blue-400">
                <CardContent className="flex items-center gap-3 p-4">
                  {cat.image_url ? (
                    <img src={cat.image_url} alt={cat.name} className="h-10 w-10 rounded object-cover border" />
                  ) : (
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded border bg-slate-100 text-xs font-bold text-slate-600">
                      {cat.name.slice(0, 2).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-900">{cat.name}</p>
                    <p className="truncate text-[11px] text-slate-500">Explore catalog</p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      {/* Featured Products */}
      {featuredProducts.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-slate-900">Featured Wholesale Products</h2>
            <Link to="/customer/products" className="text-xs font-medium text-blue-700 hover:underline">
              Browse all
            </Link>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {featuredProducts.map((p) => (
              <CustomerProductCard key={p.id} product={p} />
            ))}
          </div>
        </section>
      )}

      {/* Recently Added Products */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900">
            <Package className="h-4 w-4 text-blue-700" />
            Recently Added Products
          </h2>
          <Link to="/customer/products" className="text-xs font-medium text-blue-700 hover:underline">
            View full catalog
          </Link>
        </div>
        {recentProducts.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-slate-500">
              No published products are available in the catalog yet.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {recentProducts.map((p) => (
              <CustomerProductCard key={p.id} product={p} />
            ))}
          </div>
        )}
      </section>

      {/* Popular In-Stock Products */}
      {popularProducts.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-bold text-slate-900">Ready-to-Ship Stock</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {popularProducts.map((p) => (
              <CustomerProductCard key={p.id} product={p} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
