import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, LayoutGrid } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { Category, CustomerCatalogProduct } from "@/types/database";
import { Card, CardContent } from "@/components/ui/card";
import { CustomerProductCard } from "@/components/customer/CustomerProductCard";

export function CustomerCategoriesPage() {
  const { id } = useParams<{ id: string }>();

  const { data: categories = [], isLoading: loadingCats } = useQuery({
    queryKey: ["customer-all-categories"],
    queryFn: async () => {
      const { data } = await supabase
        .from("categories")
        .select("*")
        .eq("status", "active")
        .order("sort_order")
        .order("name");
      return (data ?? []) as Category[];
    },
  });

  const activeCategory = categories.find((c) => c.id === id) || null;
  const subCategoryIds = id ? categories.filter((c) => c.parent_id === id).map((c) => c.id) : [];

  const { data: products = [], isLoading: loadingProds } = useQuery({
    queryKey: ["customer-category-products", id, subCategoryIds.join(",")],
    enabled: Boolean(id),
    queryFn: async () => {
      const targetIds = [id!, ...subCategoryIds];
      const { data } = await supabase
        .from("v_customer_catalog")
        .select("*")
        .in("category_id", targetIds)
        .order("name");
      return (data ?? []) as CustomerCatalogProduct[];
    },
  });

  if (id) {
    const subcategories = categories.filter((c) => c.parent_id === id);
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <Link to="/customer/categories" className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900">
              <ArrowLeft className="h-3.5 w-3.5" />
              All Categories
            </Link>
            <h1 className="mt-1 text-2xl font-bold text-slate-900">{activeCategory?.name || "Category Catalog"}</h1>
            {activeCategory?.description && <p className="text-sm text-slate-500">{activeCategory.description}</p>}
          </div>
        </div>

        {subcategories.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {subcategories.map((sub) => (
              <Link
                key={sub.id}
                to={`/customer/categories/${sub.id}`}
                className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-blue-400"
              >
                {sub.name}
              </Link>
            ))}
          </div>
        )}

        {loadingProds ? (
          <div className="py-12 text-center text-sm text-slate-500">Loading products...</div>
        ) : products.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-sm text-slate-500">
              No published products available in this category yet.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((p) => (
              <CustomerProductCard key={p.id} product={p} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
          <LayoutGrid className="h-5 w-5 text-blue-700" />
          Browse Product Categories
        </h1>
        <p className="text-sm text-slate-500">Select a category to view all published wholesale items.</p>
      </div>

      {loadingCats ? (
        <div className="py-12 text-center text-sm text-slate-500">Loading categories...</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {categories.map((cat) => (
            <Link key={cat.id} to={`/customer/categories/${cat.id}`}>
              <Card className="h-full transition-colors hover:border-blue-400">
                <CardContent className="flex items-start gap-4 p-5">
                  {cat.image_url ? (
                    <img src={cat.image_url} alt={cat.name} className="h-14 w-14 rounded-md border object-cover" />
                  ) : (
                    <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md border bg-slate-100 text-sm font-bold text-slate-600">
                      {cat.name.slice(0, 2).toUpperCase()}
                    </div>
                  )}
                  <div>
                    <h3 className="font-semibold text-slate-900">{cat.name}</h3>
                    <p className="mt-1 line-clamp-2 text-xs text-slate-500">
                      {cat.description || "Browse wholesale products in this category."}
                    </p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
