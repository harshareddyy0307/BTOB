import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Plus, Package, Pencil, Copy, Trash2, Globe, GlobeLock } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { formatCurrency, formatQty } from "@/lib/utils";
import type { AdminProduct, Category, Manufacturer } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { ProductFormDialog } from "@/components/admin/ProductFormDialog";
import { useToast } from "@/components/ui/toast";

export function ProductCatalogPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("all");
  const [manufacturerId, setManufacturerId] = useState("all");
  const [availability, setAvailability] = useState("all");
  const [publishedFilter, setPublishedFilter] = useState("all");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AdminProduct | null>(null);
  const [duplicateMode, setDuplicateMode] = useState(false);

  const { data: categories = [] } = useQuery({
    queryKey: ["admin-categories"],
    queryFn: async () => {
      const { data } = await supabase.from("categories").select("*").order("name");
      return (data ?? []) as Category[];
    },
  });

  const { data: manufacturers = [] } = useQuery({
    queryKey: ["admin-manufacturers-simple"],
    queryFn: async () => {
      const { data } = await supabase.from("manufacturers").select("id, company_name, status").order("company_name");
      return (data ?? []) as Pick<Manufacturer, "id" | "company_name" | "status">[];
    },
  });

  const { data: products = [], isLoading } = useQuery({
    queryKey: ["admin-all-products"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select(
          "*, manufacturer:manufacturers(id, company_name, status), category:categories(id, name, slug), product_images(*), product_prices(*), inventory(*)"
        )
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as AdminProduct[];
    },
  });

  const togglePublish = async (p: AdminProduct) => {
    try {
      if (!p.is_published) {
        if (Number(p.product_prices?.draft_selling_price ?? 0) <= 0) {
          toast({ title: "Cannot publish product with ₹0 selling price", type: "error" });
          return;
        }
        const { error } = await supabase.rpc("publish_product_prices", {
          p_product_ids: [p.id],
          p_mark_products_published: true,
        });
        if (error) throw error;
        toast({ title: `"${p.name}" published to Customer Catalog`, type: "success" });
      } else {
        const { error } = await supabase.from("products").update({ is_published: false }).eq("id", p.id);
        if (error) throw error;
        toast({ title: `"${p.name}" unpublished from Customer Catalog`, type: "info" });
      }
      queryClient.invalidateQueries({ queryKey: ["admin-all-products"] });
    } catch (err) {
      toast({ title: "Action failed", description: err instanceof Error ? err.message : "Error", type: "error" });
    }
  };

  const handleDelete = async (p: AdminProduct) => {
    if (!confirm(`Delete "${p.name}" (${p.sku})?`)) return;
    const { error } = await supabase.from("products").delete().eq("id", p.id);
    if (error) {
      toast({ title: "Cannot delete product", description: error.message, type: "error" });
      return;
    }
    toast({ title: "Product deleted", type: "success" });
    queryClient.invalidateQueries({ queryKey: ["admin-all-products"] });
  };

  const filtered = products.filter((p) => {
    const q = search.toLowerCase();
    const matchesSearch =
      !q ||
      p.name.toLowerCase().includes(q) ||
      p.sku.toLowerCase().includes(q) ||
      (p.manufacturer?.company_name || "").toLowerCase().includes(q);
    if (!matchesSearch) return false;
    if (categoryId !== "all" && p.category_id !== categoryId) return false;
    if (manufacturerId !== "all" && p.manufacturer_id !== manufacturerId) return false;
    if (publishedFilter === "published" && !p.is_published) return false;
    if (publishedFilter === "unpublished" && p.is_published) return false;

    const avail = Number(p.inventory?.available_quantity ?? 0);
    const thresh = Number(p.inventory?.low_stock_threshold ?? 10);
    const stockStat = avail <= 0 ? "out_of_stock" : avail <= thresh ? "low_stock" : "in_stock";
    if (availability !== "all" && stockStat !== availability) return false;

    const sell = Number(p.product_prices?.draft_selling_price ?? 0);
    if (minPrice && sell < Number(minPrice)) return false;
    if (maxPrice && sell > Number(maxPrice)) return false;

    return true;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Centralized Product Catalog</h1>
          <p className="text-sm text-slate-500">
            Combined catalog across all manufacturers. Admin-only manufacturer cost and margin details are never exposed to customers.
          </p>
        </div>
        <Button
          onClick={() => {
            setEditing(null);
            setDuplicateMode(false);
            setDialogOpen(true);
          }}
        >
          <Plus className="h-4 w-4" />
          Add Product
        </Button>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-6">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, SKU, manufacturer..."
            className="lg:col-span-2"
          />
          <Select value={categoryId} onValueChange={setCategoryId}>
            <SelectTrigger>
              <SelectValue placeholder="Category" />
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

          <Select value={manufacturerId} onValueChange={setManufacturerId}>
            <SelectTrigger>
              <SelectValue placeholder="Manufacturer" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Manufacturers</SelectItem>
              {manufacturers.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.company_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={availability} onValueChange={setAvailability}>
            <SelectTrigger>
              <SelectValue placeholder="Availability" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Stock Status</SelectItem>
              <SelectItem value="in_stock">In Stock</SelectItem>
              <SelectItem value="low_stock">Low Stock</SelectItem>
              <SelectItem value="out_of_stock">Out of Stock</SelectItem>
            </SelectContent>
          </Select>

          <Select value={publishedFilter} onValueChange={setPublishedFilter}>
            <SelectTrigger>
              <SelectValue placeholder="Publication" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="published">Published</SelectItem>
              <SelectItem value="unpublished">Unpublished</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex items-center gap-2 lg:col-span-2">
            <Input
              type="number"
              placeholder="Min Price (₹)"
              value={minPrice}
              onChange={(e) => setMinPrice(e.target.value)}
            />
            <span className="text-slate-400">—</span>
            <Input
              type="number"
              placeholder="Max Price (₹)"
              value={maxPrice}
              onChange={(e) => setMaxPrice(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Package className="h-4 w-4 text-blue-700" />
            Products ({filtered.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Manufacturer (Admin)</TableHead>
                <TableHead>Orig. Price (Admin)</TableHead>
                <TableHead>Margin</TableHead>
                <TableHead>Selling Price</TableHead>
                <TableHead>Stock</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-8 text-center text-slate-500">
                    Loading products...
                  </TableCell>
                </TableRow>
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-8 text-center text-slate-500">
                    No matching products found.
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((p) => {
                  const avail = Number(p.inventory?.available_quantity ?? 0);
                  const thresh = Number(p.inventory?.low_stock_threshold ?? 10);
                  const stockStat = avail <= 0 ? "out_of_stock" : avail <= thresh ? "low_stock" : "in_stock";
                  const thumb = p.product_images?.find((i) => i.is_primary)?.image_url || p.product_images?.[0]?.image_url;

                  return (
                    <TableRow key={p.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          {thumb ? (
                            <img src={thumb} alt={p.name} className="h-10 w-10 rounded border object-cover" />
                          ) : (
                            <div className="flex h-10 w-10 items-center justify-center rounded border bg-slate-100 text-[10px] font-bold text-slate-500">
                              IMG
                            </div>
                          )}
                          <div>
                            <p className="font-medium text-slate-900">{p.name}</p>
                            <p className="font-mono text-xs text-slate-500">{p.sku}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-slate-600">{p.category?.name}</TableCell>
                      <TableCell className="text-xs font-medium text-slate-700">
                        <Link to={`/admin/manufacturers/${p.manufacturer_id}`} className="hover:underline">
                          {p.manufacturer?.company_name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-sm font-medium text-slate-900">
                        {formatCurrency(p.product_prices?.draft_manufacturer_price ?? 0)}
                      </TableCell>
                      <TableCell className="text-xs text-slate-600">
                        {p.product_prices?.draft_margin_percentage ?? 0}% (
                        {formatCurrency(p.product_prices?.draft_margin_amount ?? 0)})
                      </TableCell>
                      <TableCell className="font-semibold text-blue-700">
                        {formatCurrency(p.product_prices?.published_selling_price || p.product_prices?.draft_selling_price || 0)}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <span className="text-xs font-medium">{formatQty(avail)} {p.unit_of_measurement}</span>
                          <StatusBadge status={stockStat} />
                        </div>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={p.is_published ? "published" : "draft"} />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="inline-flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => togglePublish(p)}
                            title={p.is_published ? "Unpublish" : "Publish to Customer Catalog"}
                          >
                            {p.is_published ? (
                              <GlobeLock className="h-4 w-4 text-amber-600" />
                            ) : (
                              <Globe className="h-4 w-4 text-emerald-600" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => {
                              setEditing(p);
                              setDuplicateMode(false);
                              setDialogOpen(true);
                            }}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => {
                              setEditing(p);
                              setDuplicateMode(true);
                              setDialogOpen(true);
                            }}
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-red-600 hover:text-red-700"
                            onClick={() => handleDelete(p)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <ProductFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        product={editing}
        duplicateMode={duplicateMode}
        manufacturers={manufacturers}
        categories={categories}
        onSaved={() => queryClient.invalidateQueries({ queryKey: ["admin-all-products"] })}
      />
    </div>
  );
}
