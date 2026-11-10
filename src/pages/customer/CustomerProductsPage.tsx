import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Category, CustomerCatalogProduct } from "@/types/database";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { CustomerProductCard } from "@/components/customer/CustomerProductCard";

export function CustomerProductsPage() {
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState(searchParams.get("q") || "");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [stockFilter, setStockFilter] = useState("all");

  const { data: categories = [] } = useQuery({
    queryKey: ["customer-all-categories"],
    queryFn: async () => {
      const { data } = await supabase.from("categories").select("*").eq("status", "active").order("name");
      return (data ?? []) as Category[];
    },
  });

  const { data: products = [], isLoading } = useQuery({
    queryKey: ["customer-all-products"],
    queryFn: async () => {
      const { data, error } = await supabase.from("v_customer_catalog").select("*").order("name");
      if (error) throw error;
      return (data ?? []) as CustomerCatalogProduct[];
    },
  });

  const filtered = products.filter((p) => {
    const q = search.toLowerCase();
    const matchesQ =
      !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || (p.description || "").toLowerCase().includes(q);
    if (!matchesQ) return false;
    if (categoryFilter !== "all" && p.category_id !== categoryFilter) return false;
    if (stockFilter !== "all" && p.stock_status !== stockFilter) return false;
    return true;
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">All Wholesale Products</h1>
        <p className="text-sm text-slate-500">Live inventory and confirmed agency pricing for your business.</p>
      </div>

      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-3">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by product name or SKU..." />
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger>
              <SelectValue placeholder="All Categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={stockFilter} onValueChange={setStockFilter}>
            <SelectTrigger>
              <SelectValue placeholder="All Stock Statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Stock Statuses</SelectItem>
              <SelectItem value="in_stock">In Stock</SelectItem>
              <SelectItem value="low_stock">Low Stock</SelectItem>
              <SelectItem value="out_of_stock">Out of Stock</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="py-12 text-center text-sm text-slate-500">Loading catalog...</div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-slate-500">No products match your criteria.</CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((p) => (
            <CustomerProductCard key={p.id} product={p} />
          ))}
        </div>
      )}
    </div>
  );
}
