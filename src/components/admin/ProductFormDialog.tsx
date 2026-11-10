import React, { useEffect, useState } from "react";
import { Upload, Loader2, Trash2, Star } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { uploadStorageFile } from "@/lib/storage";
import { formatCurrency } from "@/lib/utils";
import type { AdminProduct, Category, Manufacturer } from "@/types/database";
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
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

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
  const [images, setImages] = useState<{ image_url: string; is_primary: boolean }[]>([]);

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
      setImages(
        (product.product_images ?? []).map((img) => ({
          image_url: img.image_url,
          is_primary: img.is_primary,
        }))
      );
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

  const handleUploadImages = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const uploaded: { image_url: string; is_primary: boolean }[] = [];
      for (const file of Array.from(files)) {
        const { url } = await uploadStorageFile("product-images", "catalog", file);
        uploaded.push({ image_url: url, is_primary: images.length === 0 && uploaded.length === 0 });
      }
      setImages((prev) => [...prev, ...uploaded]);
      toast({ title: `${uploaded.length} product image(s) uploaded`, type: "success" });
    } catch (err) {
      toast({ title: "Image upload failed", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setUploading(false);
    }
  };

  const setPrimaryImage = (idx: number) => {
    setImages((prev) => prev.map((img, i) => ({ ...img, is_primary: i === idx })));
  };

  const removeImage = (idx: number) => {
    setImages((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      if (next.length > 0 && !next.some((x) => x.is_primary)) {
        next[0].is_primary = true;
      }
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manufacturerId || !categoryId) {
      toast({ title: "Manufacturer and Category are required", type: "error" });
      return;
    }

    setSaving(true);
    try {
      const isEdit = Boolean(product && !duplicateMode);
      const payload = {
        manufacturer_id: manufacturerId,
        category_id: categoryId,
        name: name.trim(),
        sku: sku.trim().toUpperCase(),
        description: description.trim() || null,
        unit_of_measurement: unit.trim() || "pcs",
        min_order_quantity: Number(moq) || 1,
        hsn_code: hsnCode.trim() || null,
        gst_rate: Number(gstRate) || 0,
        status,
        is_featured: isFeatured,
        is_published: publishImmediately,
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

      // Sync product images
      await supabase.from("product_images").delete().eq("product_id", targetProductId);
      if (images.length > 0) {
        const imgRows = images.map((img, i) => ({
          product_id: targetProductId,
          image_url: img.image_url,
          is_primary: img.is_primary,
          sort_order: i,
        }));
        const { error: imgErr } = await supabase.from("product_images").insert(imgRows);
        if (imgErr) throw imgErr;
      }

      // Ensure inventory record exists / updates threshold
      const qtyVal = Math.max(0, Number(initialStock) || 0);
      const thresholdVal = Math.max(0, Number(lowStockThreshold) || 10);

      if (!isEdit) {
        await supabase.from("inventory").insert({
          product_id: targetProductId,
          available_quantity: qtyVal,
          low_stock_threshold: thresholdVal,
        });
        if (qtyVal > 0) {
          await supabase.from("inventory_movements").insert({
            product_id: targetProductId,
            movement_type: "restock",
            quantity_delta: qtyVal,
            balance_after: qtyVal,
            reference_type: "initial_stock",
            notes: "Initial stock recorded on product creation",
          });
        }
      } else {
        await supabase
          .from("inventory")
          .upsert({
            product_id: targetProductId,
            available_quantity: qtyVal,
            low_stock_threshold: thresholdVal,
          })
          .eq("product_id", targetProductId);
      }

      // Recalculate draft margin & selling price from manufacturer price
      const mfgPriceNum = Math.max(0, Number(manufacturerPrice) || 0);
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

      toast({
        title: isEdit ? "Product updated" : duplicateMode ? "Product duplicated" : "Product added",
        description: publishImmediately
          ? "Selling price published to the Customer Portal."
          : "Saved as draft pricing — approve in Margin & Pricing to publish.",
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

          <div className="space-y-1.5">
            <Label>Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>

          <div className="grid gap-4 sm:grid-cols-4">
            <div className="space-y-1.5">
              <Label>Manufacturer Price (₹) *</Label>
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

          <div className="grid gap-4 sm:grid-cols-4">
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

          {product?.product_prices && !duplicateMode && (
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
              Current Margin Rule: <strong className="uppercase">{product.product_prices.draft_margin_source}</strong> (
              {product.product_prices.draft_margin_percentage}%) &bull; Current Draft Selling Price:{" "}
              <strong>{formatCurrency(product.product_prices.draft_selling_price)}</strong> &bull; Published Selling
              Price: <strong>{formatCurrency(product.product_prices.published_selling_price)}</strong>
            </div>
          )}

          {/* Product Images */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Product Images</Label>
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
                {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                <span>Upload Images</span>
                <input type="file" accept="image/*" multiple className="hidden" onChange={handleUploadImages} />
              </label>
            </div>
            {images.length > 0 && (
              <div className="grid grid-cols-4 gap-3 sm:grid-cols-6">
                {images.map((img, i) => (
                  <div key={img.image_url + i} className="group relative rounded-md border bg-white p-1">
                    <img src={img.image_url} alt="Product" className="h-16 w-full rounded object-cover" />
                    <div className="mt-1 flex items-center justify-between">
                      <button
                        type="button"
                        onClick={() => setPrimaryImage(i)}
                        className={img.is_primary ? "text-amber-500" : "text-slate-400 hover:text-amber-500"}
                        title="Set as primary"
                      >
                        <Star className="h-3.5 w-3.5 fill-current" />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeImage(i)}
                        className="text-slate-400 hover:text-red-600"
                        title="Remove"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-6 rounded-md border border-slate-200 bg-slate-50/70 p-3">
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
