import React, { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import {
  calculateGrossMarginPricing,
  formatSignedCurrency,
  resolveClientEffectiveMargin,
  type MarginRuleSummary,
} from "@/lib/pricing";
import { invalidateCatalogQueries } from "@/lib/productPublishing";
import { useAuth } from "@/contexts/AuthContext";
import { formatCurrency } from "@/lib/utils";
import type { AdminProduct, Category, Manufacturer } from "@/types/database";
import {
  ProductPhotoEditor,
  cleanupUnusedProductStoragePhotos,
  finalizeProductPhotoDrafts,
  type ProductPhotoDraft,
} from "@/components/admin/ProductPhotoEditor";
import { sortProductImages } from "@/components/admin/ProductPhotoDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";

interface ProductFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: AdminProduct | null;
  duplicateMode?: boolean;
  fixedManufacturerId?: string;
  manufacturers: Pick<Manufacturer, "id" | "company_name">[];
  categories: Category[];
  onSaved: () => void;
}

export function ProductFormDialog({
  open,
  onOpenChange,
  product,
  duplicateMode = false,
  fixedManufacturerId,
  manufacturers,
  categories,
  onSaved,
}: ProductFormDialogProps) {
  const { branding } = useAuth();
  const sym = branding.currency_symbol || "₹";
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [manufacturerId, setManufacturerId] = useState(fixedManufacturerId || "");
  const [categoryId, setCategoryId] = useState("");
  const [description, setDescription] = useState("");
  const [unit, setUnit] = useState("pcs");
  const [moq, setMoq] = useState("1");
  const [hsnCode, setHsnCode] = useState("");
  const [gstRate, setGstRate] = useState("18");
  const [manufacturerPrice, setManufacturerPrice] = useState("0");
  const [initialStock, setInitialStock] = useState("0");
  const [lowStockThreshold, setLowStockThreshold] = useState("10");
  const [status, setStatus] = useState<"active" | "inactive">("active");
  const [isFeatured, setIsFeatured] = useState(false);
  const [publishImmediately, setPublishImmediately] = useState(false);
  const [images, setImages] = useState<ProductPhotoDraft[]>([]);

  useEffect(() => {
    if (!open) return;
    if (product) {
      setName(duplicateMode ? `${product.name} (Copy)` : product.name);
      setSku(duplicateMode ? `${product.sku}-COPY-${Math.floor(100 + Math.random() * 900)}` : product.sku);
      setManufacturerId(fixedManufacturerId || product.manufacturer_id);
      setCategoryId(product.category_id);
      setDescription(product.description || "");
      setUnit(product.unit_of_measurement || "pcs");
      setMoq(String(product.min_order_quantity ?? 1));
      setHsnCode(product.hsn_code || "");
      setGstRate(String(product.gst_rate ?? 18));
      setManufacturerPrice(
        String(
          product.product_prices?.draft_manufacturer_price ??
            product.product_prices?.published_manufacturer_price ??
            0
        )
      );
      setInitialStock(String(product.inventory?.available_quantity ?? 0));
      setLowStockThreshold(String(product.inventory?.low_stock_threshold ?? 10));
      setStatus(product.status);
      setIsFeatured(product.is_featured);
      setPublishImmediately(duplicateMode ? false : product.is_published);
      setImages(sortProductImages(product.product_images));
    } else {
      setName("");
      setSku("");
      setManufacturerId(fixedManufacturerId || manufacturers[0]?.id || "");
      setCategoryId(categories[0]?.id || "");
      setDescription("");
      setUnit("pcs");
      setMoq("1");
      setHsnCode("");
      setGstRate("18");
      setManufacturerPrice("0");
      setInitialStock("0");
      setLowStockThreshold("10");
      setStatus("active");
      setIsFeatured(false);
      setPublishImmediately(false);
      setImages([]);
    }
  }, [open, product, duplicateMode, fixedManufacturerId, manufacturers, categories]);

  const { data: marginRules = [] } = useQuery({
    queryKey: ["admin-margin-rules"],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("margin_rules")
        .select("id, scope, category_id, product_id, margin_percentage")
        .eq("is_active", true);
      if (error) throw error;
      return (data ?? []) as MarginRuleSummary[];
    },
  });

  const activeEditProductId = product && !duplicateMode ? product.id : null;
  const effectiveMargin = resolveClientEffectiveMargin({
    productId: activeEditProductId,
    categoryId: categoryId || null,
    categories,
    rules: marginRules,
  });
  const previewCost = Math.max(0, Number(manufacturerPrice) || 0);
  const livePricingPreview = calculateGrossMarginPricing(previewCost, effectiveMargin.marginPercentage);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manufacturerId || !categoryId) {
      toast({ title: "Manufacturer and Category are required", type: "error" });
      return;
    }

    const parsedMfgPrice = Number(manufacturerPrice);
    if (!Number.isFinite(parsedMfgPrice) || parsedMfgPrice < 0) {
      toast({ title: "Enter a valid non-negative manufacturer price", type: "error" });
      return;
    }
    const parsedMoq = Number(moq);
    if (!Number.isFinite(parsedMoq) || parsedMoq <= 0) {
      toast({ title: "Minimum Order Quantity must be greater than 0", type: "error" });
      return;
    }
    const parsedGst = Number(gstRate);
    if (!Number.isFinite(parsedGst) || parsedGst < 0 || parsedGst > 100) {
      toast({ title: "GST rate must be between 0 and 100", type: "error" });
      return;
    }
    const parsedStock = Number(initialStock);
    const parsedThreshold = Number(lowStockThreshold);
    if (!Number.isFinite(parsedStock) || parsedStock < 0 || !Number.isFinite(parsedThreshold) || parsedThreshold < 0) {
      toast({ title: "Stock and alert threshold must be zero or greater", type: "error" });
      return;
    }

    const mfgPriceNum = Math.max(0, parsedMfgPrice);
    if (publishImmediately && livePricingPreview.sellingPrice <= 0) {
      toast({
        title: `Cannot publish with ${sym}0 selling price`,
        description: `Enter a manufacturer price above ${sym}0 before publishing to Customer Catalog.`,
        type: "error",
      });
      return;
    }

    setSaving(true);
    try {
      const isEdit = Boolean(product && !duplicateMode);
      const previousUrls = isEdit ? (product?.product_images ?? []).map((img) => img.image_url) : [];
      const payload = {
        manufacturer_id: manufacturerId,
        category_id: categoryId,
        name: name.trim(),
        sku: sku.trim().toUpperCase(),
        description: description.trim() || null,
        unit_of_measurement: unit.trim() || "pcs",
        min_order_quantity: parsedMoq,
        hsn_code: hsnCode.trim() || null,
        gst_rate: parsedGst,
        status,
        is_featured: isFeatured,
        is_published: publishImmediately ? (isEdit && product ? product.is_published : false) : false,
      };

      let targetProductId = product?.id;

      if (isEdit && targetProductId) {
        const { error } = await supabase.from("products").update(payload).eq("id", targetProductId);
        if (error) throw error;
      } else {
        const { data: inserted, error } = await supabase.from("products").insert(payload).select("id").single();
        if (error || !inserted) throw error || new Error("Failed to create product");
        targetProductId = inserted.id;
      }

      if (!targetProductId) throw new Error("Missing product ID");

      // Upload staged photos now & insert replacements before deleting previous rows
      const { data: existingImgRows } = isEdit
        ? await supabase.from("product_images").select("id").eq("product_id", targetProductId)
        : { data: [] as { id: string }[] };
      const existingImgIds = (existingImgRows ?? []).map((r) => r.id);

      const finalizedPhotos = await finalizeProductPhotoDrafts(images, `catalog/${targetProductId}`);
      if (finalizedPhotos.length > 0) {
        const hasPrimary = finalizedPhotos.some((i) => i.is_primary);
        const imgRows = finalizedPhotos.map((img, i) => ({
          product_id: targetProductId,
          image_url: img.image_url,
          is_primary: hasPrimary ? img.is_primary : i === 0,
          sort_order: i,
        }));
        const { error: imgErr } = await supabase.from("product_images").insert(imgRows);
        if (imgErr) throw imgErr;
      }
      if (existingImgIds.length > 0) {
        const { error: delImgErr } = await supabase.from("product_images").delete().in("id", existingImgIds);
        if (delImgErr) throw delImgErr;
      }

      if (isEdit) {
        await cleanupUnusedProductStoragePhotos(
          previousUrls,
          finalizedPhotos.map((p) => p.image_url)
        );
      }

      // Ensure inventory record exists & tracks stock movements cleanly
      const qtyVal = Math.max(0, parsedStock);
      const thresholdVal = Math.max(0, parsedThreshold);

      if (!isEdit) {
        const { error: invErr } = await supabase.from("inventory").insert({
          product_id: targetProductId,
          available_quantity: qtyVal,
          low_stock_threshold: thresholdVal,
        });
        if (invErr) throw invErr;
        if (qtyVal > 0) {
          const { error: movErr } = await supabase.from("inventory_movements").insert({
            product_id: targetProductId,
            movement_type: "restock",
            quantity_delta: qtyVal,
            balance_after: qtyVal,
            reference_type: "initial_stock",
            notes: "Initial stock recorded on product creation",
          });
          if (movErr) throw movErr;
        }
      } else {
        const prevQty = Number(product?.inventory?.available_quantity ?? 0);
        const delta = Math.round((qtyVal - prevQty) * 100) / 100;
        const { error: invErr } = await supabase.rpc("adjust_product_stock_and_threshold_admin", {
          p_product_id: targetProductId,
          p_quantity_delta: delta,
          p_low_stock_threshold: thresholdVal,
          p_movement_type: "adjustment",
          p_notes: "Adjusted in product editor",
        });
        if (invErr) throw invErr;
      }

      // Recalculate draft margin & selling price from manufacturer price
      const { error: priceErr } = await supabase.rpc("recalculate_product_draft_price", {
        p_product_id: targetProductId,
        p_new_manufacturer_price: mfgPriceNum,
        p_notes: isEdit ? "Manufacturer price updated in product editor" : "Initial manufacturer price set",
      });
      if (priceErr) throw priceErr;

      if (publishImmediately) {
        const { error: pubErr } = await supabase.rpc("publish_product_prices", {
          p_product_ids: [targetProductId],
          p_mark_products_published: true,
        });
        if (pubErr) throw pubErr;
      }

      await Promise.all([
        invalidateCatalogQueries(queryClient),
        queryClient.invalidateQueries({ queryKey: ["admin-inventory"] }),
        queryClient.invalidateQueries({ queryKey: ["admin-inventory-movements"] }),
      ]);

      toast({
        title: isEdit ? "Product updated" : duplicateMode ? "Product duplicated" : "Product added",
        description: publishImmediately
          ? "Selling price published to the Customer Portal."
          : "Saved as draft pricing — approve in Margin & Pricing or Catalog to publish.",
        type: "success",
      });
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast({
        title: "Failed to save product",
        description: err instanceof Error ? err.message : "Error",
        type: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {product ? (duplicateMode ? "Duplicate Product" : "Edit Product") : "Add Manufacturer Product"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Product Name *</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. 18W Commercial LED Bulb" />
            </div>
            <div className="space-y-1.5">
              <Label>SKU *</Label>
              <Input value={sku} onChange={(e) => setSku(e.target.value)} required placeholder="e.g. ABC-LED-18W" />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Manufacturer (Internal Only) *</Label>
              <Select value={manufacturerId} onValueChange={setManufacturerId} disabled={Boolean(fixedManufacturerId)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select manufacturer" />
                </SelectTrigger>
                <SelectContent>
                  {manufacturers.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.company_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Category *</Label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <ProductPhotoEditor
            photos={images}
            onChange={setImages}
            disabled={saving}
            compact
          />

          <div className="space-y-1.5">
            <Label>Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
            <div className="space-y-1.5">
              <Label>Manufacturer Price ({sym}) *</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={manufacturerPrice}
                onChange={(e) => setManufacturerPrice(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label>Unit *</Label>
              <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="pcs / box / kg" required />
            </div>
            <div className="space-y-1.5">
              <Label>Min Order Qty *</Label>
              <Input type="number" step="0.01" min="0.01" value={moq} onChange={(e) => setMoq(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label>GST Rate (%)</Label>
              <Select value={gstRate} onValueChange={setGstRate}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">0% (Exempt)</SelectItem>
                  <SelectItem value="5">5% GST</SelectItem>
                  <SelectItem value="12">12% GST</SelectItem>
                  <SelectItem value="18">18% GST</SelectItem>
                  <SelectItem value="28">28% GST</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
            <div className="space-y-1.5">
              <Label>Available Stock</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={initialStock}
                onChange={(e) => setInitialStock(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Low Stock Alert At</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={lowStockThreshold}
                onChange={(e) => setLowStockThreshold(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>HSN Code</Label>
              <Input value={hsnCode} onChange={(e) => setHsnCode(e.target.value)} placeholder="e.g. 8539" />
            </div>
            <div className="space-y-1.5">
              <Label>Product Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as "active" | "inactive")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
            <span>
              Effective Rule: <strong className="uppercase">{effectiveMargin.source}</strong> (
              {effectiveMargin.marginPercentage}%) &bull; Draft Selling Price:{" "}
              <strong className="text-blue-700">{formatCurrency(livePricingPreview.sellingPrice, sym)}</strong> (Margin{" "}
              {formatSignedCurrency(livePricingPreview.marginAmount, sym)})
            </span>
            {product?.product_prices && !duplicateMode && (
              <span>
                {" "}
                &bull; Live Published Price:{" "}
                <strong>{formatCurrency(product.product_prices.published_selling_price, sym)}</strong>
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-4 rounded-md border border-slate-200 bg-slate-50/70 p-3 sm:gap-6">
            <div className="flex items-center gap-2.5">
              <Switch checked={isFeatured} onCheckedChange={setIsFeatured} />
              <Label>Featured in Customer Portal</Label>
            </div>
            <div className="flex items-center gap-2.5">
              <Switch checked={publishImmediately} onCheckedChange={setPublishImmediately} />
              <Label>Approve &amp; Publish Price to Customer Catalog Now</Label>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {product && !duplicateMode ? "Save Changes" : "Save Product"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
