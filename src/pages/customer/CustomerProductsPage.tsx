import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase, fetchAllRows } from "@/lib/supabase";
import { getCategoryAndDescendantIds } from "@/lib/categories";
import { useAuth } from "@/contexts/AuthContext";
import type { Category, CustomerCatalogProduct } from "@/types/database";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { CustomerProductCard } from "@/components/customer/CustomerProductCard";

export function CustomerProductsPage() {
  const { customerProfile } = useAuth();
  const [searchParams] = useSearchParams();
  const urlQ = searchParams.get("q") || "";
  const urlCategory = searchParams.get("category") || "";
  const [search, setSearch] = useState(urlQ);
  const [categoryFilter, setCategoryFilter] = useState(urlCategory || "all");
  const [stockFilter, setStockFilter] = useState("all");

  useEffect(() => {
    setSearch(urlQ);
  }, [urlQ]);

  useEffect(() => {
    if (urlCategory) {
      setCategoryFilter(urlCategory);
    }
  }, [urlCategory]);

  const { data: categories = [] } = useQuery({
    queryKey: ["customer-all-categories"],
    queryFn: async () => {
      const { data } = await supabase.from("categories").select("*").eq("status", "active").order("name");
      return (data ?? []) as Category[];
    },
  });

  const { data: products = [], isLoading } = useQuery({
    queryKey: ["customer-all-products", customerProfile?.id],
    enabled: Boolean(customerProfile?.id),
    queryFn: async () =>
      fetchAllRows<CustomerCatalogProduct>((from, to) =>
        supabase.from("v_customer_catalog").select("*").order("name").range(from, to)
      ),
  });

  const categoryMap = new Map(categories.map((c) => [c.id, c]));
  const allowedCategoryIds =
    categoryFilter === "all" ? null : new Set(getCategoryAndDescendantIds(categories, categoryFilter));

  const filtered = products.filter((p) => {
    const q = search.toLowerCase();
    const matchesQ =
      !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || (p.description || "").toLowerCase().includes(q);
    if (!matchesQ) return false;
    if (allowedCategoryIds && (!p.category_id || !allowedCategoryIds.has(p.category_id))) return false;
    if (stockFilter !== "all" && p.stock_status !== stockFilter) return false;
    return true;
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">All Wholesale Products</h1>
        <p className="text-sm text-slate-500">Live inventory and confirmed agency pricing for your business.</p>
      </div>

      <Card>
        <CardContent className="grid gap-3 p-3.5 sm:grid-cols-3 sm:p-4">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by product name or SKU..." />
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger>
              <SelectValue placeholder="All Categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {categories.map((c) => {
                const parentName = c.parent_id ? categoryMap.get(c.parent_id)?.name : null;
                return (
                  <SelectItem key={c.id} value={c.id}>
                    {parentName ? `${parentName} › ${c.name}` : c.name}
                  </SelectItem>
                );
              })}
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
