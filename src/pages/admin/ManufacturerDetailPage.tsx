import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as XLSX from "xlsx";
import {
  ArrowLeft,
  Plus,
  Upload,
  FileSpreadsheet,
  Pencil,
  Copy,
  Trash2,
  Loader2,
  Globe,
  Phone,
  Mail,
  MapPin,
  Percent,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { getManufacturerAssetSignedUrl, uploadStorageFile } from "@/lib/storage";
import { formatCurrency, formatQty } from "@/lib/utils";
import type { AdminProduct, Category, Manufacturer } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { ProductFormDialog } from "@/components/admin/ProductFormDialog";
import { useToast } from "@/components/ui/toast";

export function ManufacturerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("all");
  const [productDialogOpen, setProductDialogOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<AdminProduct | null>(null);
  const [duplicateMode, setDuplicateMode] = useState(false);

  const [galleryUrls, setGalleryUrls] = useState<string[]>([]);
  const [uploadingPhotos, setUploadingPhotos] = useState(false);

  // Bulk Price Update Dialog
  const [bulkPriceOpen, setBulkPriceOpen] = useState(false);
  const [bulkMode, setBulkMode] = useState<"percent" | "fixed">("percent");
  const [bulkValue, setBulkValue] = useState("5");
  const [applyingBulk, setApplyingBulk] = useState(false);

  // Bulk Excel Import Dialog
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);

  const { data: manufacturer, isLoading: loadingMfg } = useQuery({
    queryKey: ["admin-manufacturer", id],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("manufacturers")
        .select("*, manufacturer_categories(category_id, categories(id, name, slug))")
        .eq("id", id!)
        .single();
      if (error) throw error;
      return data as unknown as Manufacturer & {
        manufacturer_categories: { category_id: string; categories: Category }[];
      };
    },
  });

  const { data: categories = [] } = useQuery({
    queryKey: ["admin-categories"],
    queryFn: async () => {
      const { data } = await supabase.from("categories").select("*").order("name");
      return (data ?? []) as Category[];
    },
  });

  const { data: products = [], isLoading: loadingProducts } = useQuery({
    queryKey: ["admin-manufacturer-products", id],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("*, category:categories(id, name, slug), product_images(*), product_prices(*), inventory(*)")
        .eq("manufacturer_id", id!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as AdminProduct[];
    },
  });

  useEffect(() => {
    let active = true;
    async function loadGallery() {
      const paths = Array.isArray(manufacturer?.gallery_urls) ? manufacturer.gallery_urls : [];
      const resolved = await Promise.all(paths.map((p) => getManufacturerAssetSignedUrl(p)));
      if (active) setGalleryUrls(resolved.filter(Boolean));
    }
    loadGallery();
    return () => {
      active = false;
    };
  }, [manufacturer]);

  const handleGalleryUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || !manufacturer) return;
    setUploadingPhotos(true);
    try {
      const newPaths: string[] = [];
      for (const file of Array.from(files)) {
        const { path } = await uploadStorageFile("manufacturer-assets", `gallery/${manufacturer.id}`, file);
        newPaths.push(path);
      }
      const existing = Array.isArray(manufacturer.gallery_urls) ? manufacturer.gallery_urls : [];
      const { error } = await supabase
        .from("manufacturers")
        .update({ gallery_urls: [...existing, ...newPaths] })
        .eq("id", manufacturer.id);
      if (error) throw error;
      toast({ title: `${newPaths.length} company image(s) uploaded`, type: "success" });
      queryClient.invalidateQueries({ queryKey: ["admin-manufacturer", id] });
    } catch (err) {
      toast({ title: "Upload failed", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setUploadingPhotos(false);
    }
  };

  const handleBulkPriceUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    const val = Number(bulkValue);
    if (Number.isNaN(val)) return;
    setApplyingBulk(true);
    try {
      for (const p of filteredProducts) {
        const currentPrice = Number(
          p.product_prices?.draft_manufacturer_price ?? p.product_prices?.published_manufacturer_price ?? 0
        );
        const nextPrice =
          bulkMode === "percent"
            ? Math.max(0, Math.round(currentPrice * (1 + val / 100) * 100) / 100)
            : Math.max(0, Math.round((currentPrice + val) * 100) / 100);

        await supabase.rpc("recalculate_product_draft_price", {
          p_product_id: p.id,
          p_new_manufacturer_price: nextPrice,
          p_notes: `Bulk manufacturer price update (${bulkMode}: ${val})`,
        });
      }
      toast({
        title: "Manufacturer prices updated",
        description: `Recalculated ${filteredProducts.length} product(s). Review & publish in Margin & Pricing.`,
        type: "success",
      });
      setBulkPriceOpen(false);
      queryClient.invalidateQueries({ queryKey: ["admin-manufacturer-products", id] });
    } catch (err) {
      toast({ title: "Bulk update failed", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setApplyingBulk(false);
    }
  };

  const downloadImportTemplate = () => {
    const ws = XLSX.utils.json_to_sheet([
      {
        name: "18W LED Tube Light",
        sku: "MFG-LED-018",
        category_name: categories[0]?.name || "Electronics",
        description: "Cool white 6500K commercial batten",
        unit_of_measurement: "pcs",
        min_order_quantity: 10,
        hsn_code: "9405",
        gst_rate: 18,
        manufacturer_price: 165,
        available_quantity: 250,
      },
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Products");
    XLSX.writeFile(wb, "manufacturer_products_template.xlsx");
  };

  const handleExcelImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !id) return;
    setImporting(true);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf);
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
      if (rows.length === 0) throw new Error("Spreadsheet has no rows.");

      const catByName = new Map(categories.map((c) => [c.name.toLowerCase().trim(), c.id]));
      let importedCount = 0;

      for (const r of rows) {
        const prodName = String(r.name || "").trim();
        const prodSku = String(r.sku || "").trim().toUpperCase();
        if (!prodName || !prodSku) continue;

        const catKey = String(r.category_name || "").toLowerCase().trim();
        const resolvedCatId = catByName.get(catKey) || categories[0]?.id;
        if (!resolvedCatId) continue;

        const { data: created, error } = await supabase
          .from("products")
          .upsert(
            {
              manufacturer_id: id,
              category_id: resolvedCatId,
              name: prodName,
              sku: prodSku,
              description: r.description ? String(r.description) : null,
              unit_of_measurement: String(r.unit_of_measurement || "pcs"),
              min_order_quantity: Number(r.min_order_quantity) || 1,
              hsn_code: r.hsn_code ? String(r.hsn_code) : null,
              gst_rate: Number(r.gst_rate ?? 18),
              status: "active",
            },
            { onConflict: "sku" }
          )
          .select("id")
          .single();

        if (error || !created) continue;

        const stockQty = Math.max(0, Number(r.available_quantity) || 0);
        await supabase.from("inventory").upsert({
          product_id: created.id,
          available_quantity: stockQty,
          low_stock_threshold: 10,
        });

        await supabase.rpc("recalculate_product_draft_price", {
          p_product_id: created.id,
          p_new_manufacturer_price: Math.max(0, Number(r.manufacturer_price) || 0),
          p_notes: "Imported from Excel sheet",
        });

        importedCount++;
      }

      toast({ title: `Imported ${importedCount} product(s)`, type: "success" });
      setImportOpen(false);
      queryClient.invalidateQueries({ queryKey: ["admin-manufacturer-products", id] });
    } catch (err) {
      toast({ title: "Import failed", description: err instanceof Error ? err.message : "Invalid file", type: "error" });
    } finally {
      setImporting(false);
    }
  };

  const handleDeleteProduct = async (p: AdminProduct) => {
    if (!confirm(`Delete product "${p.name}" (${p.sku})?`)) return;
    const { error } = await supabase.from("products").delete().eq("id", p.id);
    if (error) {
      toast({ title: "Cannot delete product", description: error.message, type: "error" });
      return;
    }
    toast({ title: "Product deleted", type: "success" });
    queryClient.invalidateQueries({ queryKey: ["admin-manufacturer-products", id] });
  };

  const filteredProducts = products.filter((p) => {
    const matchesCat = catFilter === "all" || p.category_id === catFilter;
    const q = search.toLowerCase();
    const matchesQ = !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q);
    return matchesCat && matchesQ;
  });

  if (loadingMfg) {
    return <div className="py-12 text-center text-sm text-slate-500">Loading manufacturer profile...</div>;
  }

  if (!manufacturer) {
    return <div className="py-12 text-center text-sm text-red-600">Manufacturer not found.</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Link
          to="/admin/manufacturers"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Manufacturers
        </Link>
        <StatusBadge status={manufacturer.status} />
      </div>

      {/* Manufacturer Profile Card */}
      <Card>
        <CardContent className="p-6">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex items-start gap-4">
              {manufacturer.logo_url ? (
                <img
                  src={manufacturer.logo_url}
                  alt={manufacturer.company_name}
                  className="h-16 w-16 rounded-lg border object-cover"
                />
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded-lg border bg-slate-100 text-lg font-bold text-slate-700">
                  {manufacturer.company_name.slice(0, 2).toUpperCase()}
                </div>
              )}
              <div>
                <h1 className="text-2xl font-bold text-slate-900">{manufacturer.company_name}</h1>
                <p className="mt-1 text-sm text-slate-600">{manufacturer.description || "No description provided."}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {(manufacturer.manufacturer_categories ?? []).map((mc) => (
                    <span
                      key={mc.category_id}
                      className="rounded border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-800"
                    >
                      {mc.categories?.name}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid gap-2 text-xs text-slate-600 sm:grid-cols-2 lg:w-96">
              <div className="flex items-center gap-2">
                <Phone className="h-3.5 w-3.5 text-slate-400" />
                <span>
                  {manufacturer.contact_person} &bull; {manufacturer.phone}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Mail className="h-3.5 w-3.5 text-slate-400" />
                <span>{manufacturer.email || "—"}</span>
              </div>
              <div className="flex items-center gap-2">
                <Globe className="h-3.5 w-3.5 text-slate-400" />
                <span>{manufacturer.website || "—"}</span>
              </div>
              <div className="flex items-center gap-2 font-mono">
                <span>GSTIN: {manufacturer.gst_number || "—"}</span>
              </div>
              <div className="flex items-start gap-2 sm:col-span-2">
                <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
                <span>
                  {[manufacturer.address, manufacturer.city, manufacturer.state].filter(Boolean).join(", ")}
                </span>
              </div>
            </div>
          </div>

          {/* Company Photographs */}
          <div className="mt-6 border-t border-slate-100 pt-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Company Photographs (Internal Only)
              </h3>
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
                {uploadingPhotos ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                <span>Upload Company Images</span>
                <input type="file" accept="image/*" multiple className="hidden" onChange={handleGalleryUpload} />
              </label>
            </div>
            {galleryUrls.length > 0 ? (
              <div className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-6">
                {galleryUrls.map((url, idx) => (
                  <img key={idx} src={url} alt="Facility" className="h-20 w-full rounded border object-cover" />
                ))}
              </div>
            ) : (
              <p className="mt-2 text-xs text-slate-400">No company photographs uploaded yet.</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Manufacturer Product Catalog */}
      <Card>
        <CardHeader className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <CardTitle>Manufacturer Product Catalog ({filteredProducts.length})</CardTitle>
            <p className="text-xs text-slate-500">
              Manage original manufacturer prices, stock, and SKUs for {manufacturer.company_name}.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
              <FileSpreadsheet className="h-4 w-4" />
              Bulk Excel Import
            </Button>
            <Button variant="outline" size="sm" onClick={() => setBulkPriceOpen(true)}>
              <Percent className="h-4 w-4" />
              Bulk Price Update
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setEditingProduct(null);
                setDuplicateMode(false);
                setProductDialogOpen(true);
              }}
            >
              <Plus className="h-4 w-4" />
              Add Product
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search products by name or SKU..."
              className="sm:max-w-xs"
            />
            <Select value={catFilter} onValueChange={setCatFilter}>
              <SelectTrigger className="sm:w-56">
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
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Orig. Price</TableHead>
                <TableHead>Margin</TableHead>
                <TableHead>Selling Price</TableHead>
                <TableHead>Stock</TableHead>
                <TableHead>MOQ / Unit</TableHead>
                <TableHead>Publication</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loadingProducts ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-8 text-center text-slate-500">
                    Loading products...
                  </TableCell>
                </TableRow>
              ) : filteredProducts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-8 text-center text-slate-500">
                    No products added for this manufacturer yet.
                  </TableCell>
                </TableRow>
              ) : (
                filteredProducts.map((p) => {
                  const avail = Number(p.inventory?.available_quantity ?? 0);
                  const lowThresh = Number(p.inventory?.low_stock_threshold ?? 10);
                  const stockStat = avail <= 0 ? "out_of_stock" : avail <= lowThresh ? "low_stock" : "in_stock";
                  const thumb = p.product_images?.find((i) => i.is_primary)?.image_url || p.product_images?.[0]?.image_url;

                  return (
                    <TableRow key={p.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          {thumb ? (
                            <img src={thumb} alt={p.name} className="h-9 w-9 rounded border object-cover" />
                          ) : (
                            <div className="flex h-9 w-9 items-center justify-center rounded border bg-slate-100 text-[10px] font-bold text-slate-500">
                              SKU
                            </div>
                          )}
                          <div>
                            <p className="font-medium text-slate-900">{p.name}</p>
                            <p className="font-mono text-xs text-slate-500">{p.sku}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-slate-600">{p.category?.name}</TableCell>
                      <TableCell className="font-medium text-slate-900">
                        {formatCurrency(p.product_prices?.draft_manufacturer_price ?? 0)}
                      </TableCell>
                      <TableCell className="text-xs text-slate-600">
                        {p.product_prices?.draft_margin_percentage ?? 0}% (
                        {formatCurrency(p.product_prices?.draft_margin_amount ?? 0)})
                      </TableCell>
                      <TableCell className="font-semibold text-blue-700">
                        {formatCurrency(p.product_prices?.draft_selling_price ?? 0)}
                        {p.product_prices?.approval_status === "pending_review" && (
                          <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                            Draft
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <span className="text-xs font-medium">{formatQty(avail)}</span>
                          <StatusBadge status={stockStat} />
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-slate-600">
                        {formatQty(p.min_order_quantity)} {p.unit_of_measurement}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={p.is_published ? "published" : "draft"} />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="inline-flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Edit"
                            onClick={() => {
                              setEditingProduct(p);
                              setDuplicateMode(false);
                              setProductDialogOpen(true);
                            }}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Duplicate"
                            onClick={() => {
                              setEditingProduct(p);
                              setDuplicateMode(true);
                              setProductDialogOpen(true);
                            }}
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Delete"
                            className="text-red-600 hover:text-red-700"
                            onClick={() => handleDeleteProduct(p)}
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
        open={productDialogOpen}
        onOpenChange={setProductDialogOpen}
        product={editingProduct}
        duplicateMode={duplicateMode}
        fixedManufacturerId={id}
        manufacturers={[manufacturer]}
        categories={categories}
        onSaved={() => queryClient.invalidateQueries({ queryKey: ["admin-manufacturer-products", id] })}
      />

      {/* Bulk Price Update Dialog */}
      <Dialog open={bulkPriceOpen} onOpenChange={setBulkPriceOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Bulk Manufacturer Price Update</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleBulkPriceUpdate} className="space-y-4">
            <p className="text-xs text-slate-600">
              Updates the original manufacturer price for {filteredProducts.length} filtered product(s) and automatically
              recalculates draft selling prices using the margin engine.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Adjustment Type</Label>
                <Select value={bulkMode} onValueChange={(v) => setBulkMode(v as "percent" | "fixed")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="percent">Percentage (+/- %)</SelectItem>
                    <SelectItem value="fixed">Fixed Amount (+/- ₹)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Value (use negative to decrease)</Label>
                <Input type="number" step="0.01" value={bulkValue} onChange={(e) => setBulkValue(e.target.value)} required />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setBulkPriceOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={applyingBulk}>
                {applyingBulk && <Loader2 className="h-4 w-4 animate-spin" />}
                Recalculate Prices
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Bulk Excel Import Dialog */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Bulk Excel Product Import</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              Upload an Excel (<code>.xlsx</code> / <code>.csv</code>) file containing columns:{" "}
              <code>name, sku, category_name, description, unit_of_measurement, min_order_quantity, hsn_code, gst_rate, manufacturer_price, available_quantity</code>.
            </p>
            <div className="flex items-center gap-3">
              <Button type="button" variant="outline" size="sm" onClick={downloadImportTemplate}>
                Download Template (.xlsx)
              </Button>
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-xs font-medium text-white hover:bg-primary/90">
                {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                <span>Select Excel File</span>
                <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleExcelImport} />
              </label>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
