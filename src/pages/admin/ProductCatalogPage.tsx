import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Plus, Package, Pencil, Copy, Trash2, Globe, GlobeLock, Camera, Loader2, RefreshCw } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import {
  bulkPublishProducts,
  bulkUnpublishProducts,
  bulkUpdatePublishedPrices,
  invalidateCatalogQueries,
} from "@/lib/productPublishing";
import { isPublishedWithPendingPrice } from "@/lib/pricing";
import { formatCurrency, formatQty } from "@/lib/utils";
import type { AdminProduct, Category, Manufacturer } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { ProductFormDialog } from "@/components/admin/ProductFormDialog";
import { ProductPhotoDialog, sortProductImages } from "@/components/admin/ProductPhotoDialog";
import { useToast } from "@/components/ui/toast";

export function ProductCatalogPage() {
  const { userProfile } = useAuth();
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
  const [photoProduct, setPhotoProduct] = useState<AdminProduct | null>(null);
  const [bulkAction, setBulkAction] = useState<"publish" | "update_live" | "unpublish" | null>(null);

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
      await invalidateCatalogQueries(queryClient);
    } catch (err) {
      toast({ title: "Action failed", description: err instanceof Error ? err.message : "Error", type: "error" });
    }
  };

  const handlePublishAll = async () => {
    if (draftTargets.length === 0) return;
    setBulkAction("publish");
    try {
      const { publishedCount, skippedZeroPriceCount } = await bulkPublishProducts(filtered, queryClient);
      if (publishedCount === 0 && skippedZeroPriceCount > 0) {
        toast({
          title: "Cannot publish ₹0 price products",
          description: `${skippedZeroPriceCount} unpublished product(s) have a ₹0 selling price. Set manufacturer price or margin first.`,
          type: "error",
        });
        return;
      }
      toast({
        title: `Published ${publishedCount} product(s) to Customer Catalog`,
        description:
          skippedZeroPriceCount > 0
            ? `Skipped ${skippedZeroPriceCount} product(s) with ₹0 selling price.`
            : undefined,
        type: "success",
      });
    } catch (err) {
      toast({ title: "Bulk publish failed", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setBulkAction(null);
    }
  };

  const handleUnpublishAll = async () => {
    if (publishedTargets.length === 0) return;
    setBulkAction("unpublish");
    try {
      const { unpublishedCount } = await bulkUnpublishProducts(filtered, userProfile?.id, queryClient);
      toast({
        title: `Unpublished ${unpublishedCount} product(s) from Customer Catalog`,
        type: "info",
      });
    } catch (err) {
      toast({ title: "Bulk unpublish failed", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setBulkAction(null);
    }
  };

  const handleUpdatePublishedPrices = async () => {
    if (livePriceUpdateTargets.length === 0) return;
    setBulkAction("update_live");
    try {
      const { updatedCount, skippedZeroPriceCount } = await bulkUpdatePublishedPrices(filtered, queryClient);
      if (updatedCount === 0 && skippedZeroPriceCount > 0) {
        toast({
          title: "Cannot update ₹0 price products",
          description: `${skippedZeroPriceCount} published product(s) have a ₹0 draft selling price.`,
          type: "error",
        });
        return;
      }
      toast({
        title: `Updated live selling prices for ${updatedCount} published product(s)`,
        description:
          skippedZeroPriceCount > 0
            ? `Skipped ${skippedZeroPriceCount} ₹0-price item(s). Draft products remain unpublished.`
            : "Customer Portal now shows the updated prices for published products.",
        type: "success",
      });
    } catch (err) {
      toast({
        title: "Failed to update published prices",
        description: err instanceof Error ? err.message : "Error",
        type: "error",
      });
    } finally {
      setBulkAction(null);
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
    void invalidateCatalogQueries(queryClient);
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

  const hasActiveFilters =
    Boolean(search.trim()) ||
    categoryId !== "all" ||
    manufacturerId !== "all" ||
    availability !== "all" ||
    publishedFilter !== "all" ||
    Boolean(minPrice) ||
    Boolean(maxPrice);
  const draftTargets = filtered.filter((p) => !p.is_published);
  const publishedTargets = filtered.filter((p) => p.is_published);
  const livePriceUpdateTargets = filtered.filter((p) => isPublishedWithPendingPrice(p));

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
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="flex items-center gap-2">
            <Package className="h-4 w-4 text-blue-700" />
            Products ({filtered.length})
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {livePriceUpdateTargets.length > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-blue-200 text-blue-700 hover:bg-blue-50 hover:text-blue-800"
                disabled={bulkAction !== null}
                onClick={handleUpdatePublishedPrices}
                title="Update live Customer Portal prices for published products without publishing Draft items"
              >
                {bulkAction === "update_live" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {hasActiveFilters
                  ? `Update Published Prices (${livePriceUpdateTargets.length})`
                  : `Update Published Prices (${livePriceUpdateTargets.length})`}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="border-emerald-200 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
              disabled={bulkAction !== null || draftTargets.length === 0}
              onClick={handlePublishAll}
            >
              {bulkAction === "publish" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />}
              {hasActiveFilters ? `Publish Filtered (${draftTargets.length})` : `Publish All (${draftTargets.length})`}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="border-amber-200 text-amber-700 hover:bg-amber-50 hover:text-amber-800"
              disabled={bulkAction !== null || publishedTargets.length === 0}
              onClick={handleUnpublishAll}
            >
              {bulkAction === "unpublish" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <GlobeLock className="h-4 w-4" />
              )}
              {hasActiveFilters
                ? `Unpublish Filtered (${publishedTargets.length})`
                : `Unpublish All (${publishedTargets.length})`}
            </Button>
          </div>
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
                  const sortedPhotos = sortProductImages(p.product_images);
                  const thumb = sortedPhotos[0]?.image_url;

                  return (
                    <TableRow key={p.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            onClick={() => setPhotoProduct(p)}
                            title={thumb ? "Manage product photos" : "Add product photo"}
                            className="group relative h-11 w-11 shrink-0 overflow-hidden rounded-md border bg-slate-50 transition-colors hover:border-blue-500"
                          >
                            {thumb ? (
                              <>
                                <img src={thumb} alt={p.name} className="h-full w-full object-cover" />
                                <span className="absolute inset-0 flex items-center justify-center bg-slate-900/45 text-white opacity-0 transition-opacity group-hover:opacity-100">
                                  <Camera className="h-3.5 w-3.5" />
                                </span>
                                {sortedPhotos.length > 1 && (
                                  <span className="absolute bottom-0.5 right-0.5 rounded bg-slate-900/80 px-1 text-[9px] font-semibold text-white">
                                    +{sortedPhotos.length - 1}
                                  </span>
                                )}
                              </>
                            ) : (
                              <span className="flex h-full w-full flex-col items-center justify-center gap-0.5 border border-dashed border-slate-300 text-[9px] font-medium text-slate-500 group-hover:border-blue-400 group-hover:text-blue-700">
                                <Camera className="h-3.5 w-3.5" />
                                <span>Photo</span>
                              </span>
                            )}
                          </button>
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
                        <div>
                          <span>{formatCurrency(p.product_prices?.draft_selling_price ?? 0)}</span>
                          {p.product_prices?.approval_status === "pending_review" && (
                            <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                              Draft
                            </span>
                          )}
                        </div>
                        {isPublishedWithPendingPrice(p) && (
                          <p className="text-[11px] font-normal text-slate-500">
                            Live: {formatCurrency(p.product_prices?.published_selling_price ?? 0)}
                          </p>
                        )}
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
                            variant="outline"
                            size="sm"
                            className="h-7 shrink-0 whitespace-nowrap px-2 text-xs"
                            onClick={() => setPhotoProduct(p)}
                            title={sortedPhotos.length > 0 ? "Manage Photos" : "Add Photo"}
                          >
                            <Camera className="h-3.5 w-3.5 text-blue-700" />
                            <span>{sortedPhotos.length > 0 ? `Photos (${sortedPhotos.length})` : "Add Photo"}</span>
                          </Button>
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
        onSaved={() => void invalidateCatalogQueries(queryClient)}
      />

      <ProductPhotoDialog
        open={Boolean(photoProduct)}
        onOpenChange={(open) => {
          if (!open) setPhotoProduct(null);
        }}
        product={photoProduct}
        onSaved={() => void invalidateCatalogQueries(queryClient)}
      />
    </div>
  );
}
