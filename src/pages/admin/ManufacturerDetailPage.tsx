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
  GlobeLock,
  Phone,
  Mail,
  MapPin,
  Percent,
  Camera,
  RefreshCw,
  FileDown,
} from "lucide-react";
import { exportSingleManufacturerPdf } from "@/lib/adminPdfExports";
import {
  buildUniqueCategorySlug,
  extractSpreadsheetProductRows,
  normalizeCategoryLookupKey,
  parseSpreadsheetNumber,
  pickWorkbookProductSheet,
} from "@/lib/excelProductImport";
import { fetchAllRows, supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import {
  bulkPublishProducts,
  bulkUnpublishProducts,
  bulkUpdatePublishedPrices,
  invalidateCatalogQueries,
} from "@/lib/productPublishing";
import { getCategoryAndDescendantIds } from "@/lib/categories";
import { isPublishedWithPendingPrice } from "@/lib/pricing";
import { RASTER_IMAGE_ACCEPT, getManufacturerAssetSignedUrl, uploadStorageFile } from "@/lib/storage";
import { formatCurrency, formatQty, slugify } from "@/lib/utils";
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
import { ProductPhotoDialog, sortProductImages } from "@/components/admin/ProductPhotoDialog";
import { useToast } from "@/components/ui/toast";

export function ManufacturerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { userProfile, branding } = useAuth();
  const sym = branding.currency_symbol || "₹";
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("all");
  const [productDialogOpen, setProductDialogOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<AdminProduct | null>(null);
  const [duplicateMode, setDuplicateMode] = useState(false);
  const [photoProduct, setPhotoProduct] = useState<AdminProduct | null>(null);
  const [bulkPublishAction, setBulkPublishAction] = useState<"publish" | "update_live" | "unpublish" | null>(null);

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
  const [autoCreateCategories, setAutoCreateCategories] = useState(true);
  const [importFeedback, setImportFeedback] = useState<{
    kind: "error" | "warning" | "success";
    summary: string;
    details: string[];
  } | null>(null);
  const [exportingPdf, setExportingPdf] = useState(false);

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
      return await fetchAllRows<AdminProduct>((from, to) =>
        supabase
          .from("products")
          .select("*, category:categories(id, name, slug), product_images(*), product_prices(*), inventory(*)")
          .eq("manufacturer_id", id!)
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to)
      );
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

        const { error: priceErr } = await supabase.rpc("recalculate_product_draft_price", {
          p_product_id: p.id,
          p_new_manufacturer_price: nextPrice,
          p_notes: `Bulk manufacturer price update (${bulkMode}: ${val})`,
        });
        if (priceErr) throw priceErr;
      }
      toast({
        title: "Manufacturer prices updated",
        description: `Recalculated ${filteredProducts.length} product(s). Review & publish or update live prices.`,
        type: "success",
      });
      setBulkPriceOpen(false);
      await invalidateCatalogQueries(queryClient);
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
    setImportFeedback(null);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf);
      const sheet = pickWorkbookProductSheet(wb);
      if (!sheet) throw new Error("Spreadsheet contains no readable worksheets.");
      const rows = extractSpreadsheetProductRows(sheet);
      if (rows.length === 0) throw new Error("Spreadsheet has no product data rows.");

      const { data: liveCategories, error: catLoadErr } = await supabase
        .from("categories")
        .select("id, name, slug, sort_order")
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true });
      if (catLoadErr) throw catLoadErr;

      const catByKey = new Map<string, { id: string; name: string }>();
      const catBySlug = new Map<string, { id: string; name: string }>();
      const usedSlugs = new Set<string>();
      let nextSortOrder = 0;

      for (const c of liveCategories ?? []) {
        const key = normalizeCategoryLookupKey(c.name);
        if (key && !catByKey.has(key)) catByKey.set(key, { id: c.id, name: c.name });
        const normSlug = slugify(c.slug || c.name);
        if (normSlug && !catBySlug.has(normSlug)) catBySlug.set(normSlug, { id: c.id, name: c.name });
        if (c.slug) usedSlugs.add(c.slug.toLowerCase());
        if (typeof c.sort_order === "number" && c.sort_order >= nextSortOrder) {
          nextSortOrder = c.sort_order + 10;
        }
      }

      const createdCategoryNames: string[] = [];
      const resolveOrCreateCategory = async (rawCategoryName: string): Promise<{ id: string } | { error: string }> => {
        const cleanName = rawCategoryName.replace(/\s+/g, " ").trim();
        if (cleanName) {
          const byKey = catByKey.get(normalizeCategoryLookupKey(cleanName));
          if (byKey) return { id: byKey.id };
          const slugCandidate = slugify(cleanName);
          if (slugCandidate) {
            const bySlug = catBySlug.get(slugCandidate);
            if (bySlug) return { id: bySlug.id };
          }
          if (!autoCreateCategories) {
            return { error: `unknown category "${cleanName}"` };
          }
        } else {
          const fallbackId =
            manufacturer?.manufacturer_categories?.[0]?.category_id || liveCategories?.[0]?.id || undefined;
          if (fallbackId) return { id: fallbackId };
          if (!autoCreateCategories) {
            return { error: "no category available" };
          }
        }

        const newName = cleanName || "General";
        let candidateSlug = buildUniqueCategorySlug(newName, usedSlugs);

        for (let attempt = 0; attempt < 3; attempt++) {
          const { data: createdCat, error: createCatErr } = await supabase
            .from("categories")
            .insert({
              name: newName,
              slug: candidateSlug,
              status: "active",
              sort_order: nextSortOrder,
            })
            .select("id, name, slug")
            .single();

          if (!createCatErr && createdCat) {
            nextSortOrder += 10;
            usedSlugs.add(createdCat.slug.toLowerCase());
            catByKey.set(normalizeCategoryLookupKey(createdCat.name), { id: createdCat.id, name: createdCat.name });
            const createdNormSlug = slugify(createdCat.slug || createdCat.name);
            if (createdNormSlug) catBySlug.set(createdNormSlug, { id: createdCat.id, name: createdCat.name });
            createdCategoryNames.push(createdCat.name);
            return { id: createdCat.id };
          }

          if (createCatErr?.code === "23505") {
            const { data: existingMatch } = await supabase
              .from("categories")
              .select("id, name, slug")
              .eq("slug", candidateSlug)
              .maybeSingle();
            if (existingMatch) {
              usedSlugs.add(existingMatch.slug.toLowerCase());
              catByKey.set(normalizeCategoryLookupKey(existingMatch.name), {
                id: existingMatch.id,
                name: existingMatch.name,
              });
              catByKey.set(normalizeCategoryLookupKey(newName), {
                id: existingMatch.id,
                name: existingMatch.name,
              });
              return { id: existingMatch.id };
            }
            usedSlugs.add(candidateSlug);
            candidateSlug = buildUniqueCategorySlug(`${newName}-${attempt + 2}`, usedSlugs);
            continue;
          }

          return { error: `could not create category "${newName}": ${createCatErr?.message || "Insert failed"}` };
        }

        return { error: `could not create category "${newName}"` };
      };

      const candidateSkus = Array.from(new Set(rows.map((r) => r.sku).filter(Boolean)));
      const existingBySku = new Map<
        string,
        { id: string; manufacturer_id: string; available_quantity: number; low_stock_threshold: number }
      >();

      for (let i = 0; i < candidateSkus.length; i += 200) {
        const chunk = candidateSkus.slice(i, i + 200);
        const { data: existingRows, error: lookupErr } = await supabase
          .from("products")
          .select("id, sku, manufacturer_id, inventory(available_quantity, low_stock_threshold)")
          .in("sku", chunk);
        if (lookupErr) throw lookupErr;
        for (const row of existingRows ?? []) {
          const inv = Array.isArray(row.inventory) ? row.inventory[0] : row.inventory;
          existingBySku.set(String(row.sku).toUpperCase(), {
            id: row.id,
            manufacturer_id: row.manufacturer_id,
            available_quantity: Number(inv?.available_quantity ?? 0),
            low_stock_threshold: Number(inv?.low_stock_threshold ?? 10),
          });
        }
      }

      let importedCount = 0;
      const skippedReasons: string[] = [];
      const usedCategoryIds = new Set<string>();

      for (const row of rows) {
        const { rowLabel, name: prodName, sku: prodSku } = row;
        if (!prodName || !prodSku) {
          skippedReasons.push(`${rowLabel}: missing name or SKU`);
          continue;
        }

        const existing = existingBySku.get(prodSku);
        if (existing && existing.manufacturer_id !== id) {
          skippedReasons.push(`${rowLabel} (${prodSku}): SKU belongs to another manufacturer`);
          continue;
        }

        const mfgPriceNum = parseSpreadsheetNumber(row.mfgPriceRaw, 0);
        if (mfgPriceNum === null || mfgPriceNum < 0) {
          skippedReasons.push(`${rowLabel} (${prodSku}): invalid manufacturer_price`);
          continue;
        }

        const stockQty = parseSpreadsheetNumber(row.stockRaw, 0);
        if (stockQty === null || stockQty < 0) {
          skippedReasons.push(`${rowLabel} (${prodSku}): invalid available_quantity`);
          continue;
        }

        const moqVal = parseSpreadsheetNumber(row.moqRaw, 1);
        if (moqVal === null || moqVal <= 0) {
          skippedReasons.push(`${rowLabel} (${prodSku}): min_order_quantity must be > 0`);
          continue;
        }

        const gstVal = parseSpreadsheetNumber(row.gstRaw, 18);
        if (gstVal === null || gstVal < 0 || gstVal > 100) {
          skippedReasons.push(`${rowLabel} (${prodSku}): gst_rate must be 0-100`);
          continue;
        }

        const catResult = await resolveOrCreateCategory(row.categoryName);
        if ("error" in catResult) {
          skippedReasons.push(`${rowLabel} (${prodSku}): ${catResult.error}`);
          continue;
        }
        const resolvedCatId = catResult.id;

        const basePayload = {
          manufacturer_id: id,
          category_id: resolvedCatId,
          name: prodName,
          sku: prodSku,
          description: row.description,
          unit_of_measurement: row.unitOfMeasurement,
          min_order_quantity: moqVal,
          hsn_code: row.hsnCode,
          gst_rate: gstVal,
          status: "active" as const,
        };

        let newlyCreatedProductId: string | null = null;
        try {
          let targetId: string;
          if (existing) {
            const { error: updErr } = await supabase.from("products").update(basePayload).eq("id", existing.id);
            if (updErr) {
              skippedReasons.push(`${rowLabel} (${prodSku}): ${updErr.message}`);
              continue;
            }
            targetId = existing.id;

            const delta = Math.round((stockQty - existing.available_quantity) * 100) / 100;
            const { error: invErr } = await supabase.rpc("adjust_product_stock_and_threshold_admin", {
              p_product_id: targetId,
              p_quantity_delta: delta,
              p_low_stock_threshold: existing.low_stock_threshold,
              p_movement_type: "adjustment",
              p_notes: "Updated via Excel bulk import",
            });
            if (invErr) throw invErr;
            existing.available_quantity = stockQty;
          } else {
            const { data: created, error: insErr } = await supabase
              .from("products")
              .insert(basePayload)
              .select("id")
              .single();
            if (insErr || !created) {
              skippedReasons.push(`${rowLabel} (${prodSku}): ${insErr?.message || "Insert failed"}`);
              continue;
            }
            targetId = created.id;
            newlyCreatedProductId = created.id;

            const { error: invErr } = await supabase.from("inventory").insert({
              product_id: targetId,
              available_quantity: stockQty,
              low_stock_threshold: 10,
            });
            if (invErr) throw invErr;
            if (stockQty > 0) {
              const { error: movErr } = await supabase.from("inventory_movements").insert({
                product_id: targetId,
                movement_type: "restock",
                quantity_delta: stockQty,
                balance_after: stockQty,
                reference_type: "excel_import",
                notes: "Initial stock imported via Excel",
              });
              if (movErr) throw movErr;
            }
            existingBySku.set(prodSku, {
              id: targetId,
              manufacturer_id: id,
              available_quantity: stockQty,
              low_stock_threshold: 10,
            });
          }

          const { error: priceErr } = await supabase.rpc("recalculate_product_draft_price", {
            p_product_id: targetId,
            p_new_manufacturer_price: Math.round(mfgPriceNum * 100) / 100,
            p_notes: "Imported from Excel sheet",
          });
          if (priceErr) throw priceErr;

          usedCategoryIds.add(resolvedCatId);
          importedCount++;
        } catch (rowErr) {
          if (newlyCreatedProductId) {
            await supabase.from("products").delete().eq("id", newlyCreatedProductId);
            existingBySku.delete(prodSku);
          }
          const msg = rowErr instanceof Error ? rowErr.message : "Failed saving product";
          skippedReasons.push(`${rowLabel} (${prodSku}): ${msg}`);
        }
      }

      if (usedCategoryIds.size > 0) {
        const { error: linkErr } = await supabase
          .from("manufacturer_categories")
          .upsert(
            Array.from(usedCategoryIds).map((catId) => ({
              manufacturer_id: id,
              category_id: catId,
            })),
            { onConflict: "manufacturer_id,category_id", ignoreDuplicates: true }
          );
        if (linkErr) {
          skippedReasons.push(`Category link warning: ${linkErr.message}`);
        }
      }

      if (importedCount > 0 || createdCategoryNames.length > 0) {
        await Promise.all([
          invalidateCatalogQueries(queryClient),
          queryClient.invalidateQueries({ queryKey: ["admin-inventory"] }),
          queryClient.invalidateQueries({ queryKey: ["admin-inventory-movements"] }),
          queryClient.invalidateQueries({ queryKey: ["admin-categories"] }),
          queryClient.invalidateQueries({ queryKey: ["customer-categories"] }),
          queryClient.invalidateQueries({ queryKey: ["customer-all-categories"] }),
          queryClient.invalidateQueries({ queryKey: ["admin-manufacturer", id] }),
          queryClient.invalidateQueries({ queryKey: ["admin-manufacturers"] }),
          queryClient.invalidateQueries({ queryKey: ["admin-margin-rules"] }),
        ]);
      }

      if (importedCount === 0 && skippedReasons.length > 0) {
        setImportFeedback({
          kind: "error",
          summary: `No products were imported (${skippedReasons.length} row issue${skippedReasons.length === 1 ? "" : "s"}).`,
          details: skippedReasons,
        });
        toast({
          title: "Import failed",
          description: skippedReasons.slice(0, 3).join("; "),
          type: "error",
        });
        return;
      }

      const categoryNote =
        createdCategoryNames.length > 0
          ? ` • Auto-created ${createdCategoryNames.length} categor${createdCategoryNames.length === 1 ? "y" : "ies"}: ${createdCategoryNames.slice(0, 3).join(", ")}${createdCategoryNames.length > 3 ? ` (+${createdCategoryNames.length - 3} more)` : ""}`
          : "";

      if (skippedReasons.length > 0) {
        setImportFeedback({
          kind: "warning",
          summary: `Imported ${importedCount} product(s)${categoryNote}, with ${skippedReasons.length} skipped row(s):`,
          details: skippedReasons,
        });
        toast({
          title: `Imported ${importedCount} product(s)`,
          description: `Skipped ${skippedReasons.length} row(s): ${skippedReasons.slice(0, 2).join("; ")}`,
          type: "info",
        });
        return;
      }

      toast({
        title: `Imported ${importedCount} product(s)`,
        description: categoryNote ? categoryNote.replace(/^ • /, "") : undefined,
        type: "success",
      });
      setImportOpen(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invalid file";
      setImportFeedback({
        kind: "error",
        summary: msg,
        details: [],
      });
      toast({ title: "Import failed", description: msg, type: "error" });
    } finally {
      setImporting(false);
      e.target.value = "";
    }
  };

  const handleToggleProductPublish = async (p: AdminProduct) => {
    try {
      if (!p.is_published) {
        if (Number(p.product_prices?.draft_selling_price ?? 0) <= 0) {
          toast({ title: `Cannot publish product with ${sym}0 selling price`, type: "error" });
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

  const handlePublishAllManufacturerProducts = async () => {
    if (mfgDraftTargets.length === 0) return;
    setBulkPublishAction("publish");
    try {
      const { publishedCount, skippedZeroPriceCount } = await bulkPublishProducts(filteredProducts, queryClient);
      if (publishedCount === 0 && skippedZeroPriceCount > 0) {
        toast({
          title: `Cannot publish ${sym}0 price products`,
          description: `${skippedZeroPriceCount} unpublished product(s) have a ${sym}0 selling price. Set manufacturer price or margin first.`,
          type: "error",
        });
        return;
      }
      toast({
        title: `Published ${publishedCount} product(s) to Customer Catalog`,
        description:
          skippedZeroPriceCount > 0
            ? `Skipped ${skippedZeroPriceCount} product(s) with ${sym}0 selling price.`
            : undefined,
        type: "success",
      });
    } catch (err) {
      toast({ title: "Bulk publish failed", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setBulkPublishAction(null);
    }
  };

  const handleUpdatePublishedPrices = async () => {
    if (mfgLivePriceUpdateTargets.length === 0) return;
    setBulkPublishAction("update_live");
    try {
      const { updatedCount, skippedZeroPriceCount } = await bulkUpdatePublishedPrices(filteredProducts, queryClient);
      if (updatedCount === 0 && skippedZeroPriceCount > 0) {
        toast({
          title: `Cannot update ${sym}0 price products`,
          description: `${skippedZeroPriceCount} published product(s) have a ${sym}0 draft selling price.`,
          type: "error",
        });
        return;
      }
      toast({
        title: `Updated live selling prices for ${updatedCount} published product(s)`,
        description:
          skippedZeroPriceCount > 0
            ? `Skipped ${skippedZeroPriceCount} ${sym}0-price item(s). Draft products remain unpublished.`
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
      setBulkPublishAction(null);
    }
  };

  const handleUnpublishAllManufacturerProducts = async () => {
    if (mfgPublishedTargets.length === 0) return;
    setBulkPublishAction("unpublish");
    try {
      const { unpublishedCount } = await bulkUnpublishProducts(filteredProducts, userProfile?.id, queryClient);
      toast({
        title: `Unpublished ${unpublishedCount} product(s) from Customer Catalog`,
        type: "info",
      });
    } catch (err) {
      toast({ title: "Bulk unpublish failed", description: err instanceof Error ? err.message : "Error", type: "error" });
    } finally {
      setBulkPublishAction(null);
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
    void invalidateCatalogQueries(queryClient);
  };

  const allowedCategoryIds =
    catFilter === "all" ? null : new Set(getCategoryAndDescendantIds(categories, catFilter));

  const filteredProducts = products.filter((p) => {
    const matchesCat = !allowedCategoryIds || allowedCategoryIds.has(p.category_id);
    const q = search.toLowerCase();
    const matchesQ = !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q);
    return matchesCat && matchesQ;
  });

  const hasActiveMfgFilters = Boolean(search.trim()) || catFilter !== "all";
  const mfgDraftTargets = filteredProducts.filter((p) => !p.is_published);
  const mfgPublishedTargets = filteredProducts.filter((p) => p.is_published);
  const mfgLivePriceUpdateTargets = filteredProducts.filter((p) => isPublishedWithPendingPrice(p));

  if (loadingMfg) {
    return <div className="py-12 text-center text-sm text-slate-500">Loading manufacturer profile...</div>;
  }

  if (!manufacturer) {
    return <div className="py-12 text-center text-sm text-red-600">Manufacturer not found.</div>;
  }

  const handleDownloadManufacturerPdf = async () => {
    if (!id || exportingPdf) return;
    setExportingPdf(true);
    try {
      const res = await exportSingleManufacturerPdf(id);
      toast({
        title: "Manufacturer PDF downloaded",
        description: `Exported ${res.companyName} with ${res.productCount} product(s) and ${res.poCount} purchase order(s).`,
        type: "success",
      });
    } catch (err) {
      toast({
        title: "Could not export Manufacturer PDF",
        description: err instanceof Error ? err.message : "Error",
        type: "error",
      });
    } finally {
      setExportingPdf(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link
          to="/admin/manufacturers"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Manufacturers
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleDownloadManufacturerPdf} disabled={exportingPdf}>
            {exportingPdf ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileDown className="h-3.5 w-3.5" />}
            Download Manufacturer PDF
          </Button>
          <StatusBadge status={manufacturer.status} />
        </div>
      </div>

      {/* Manufacturer Profile Card */}
      <Card>
        <CardContent className="p-4 sm:p-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
            <div className="flex items-start gap-3 sm:gap-4">
              {manufacturer.logo_url ? (
                <img
                  src={manufacturer.logo_url}
                  alt={manufacturer.company_name}
                  className="h-14 w-14 shrink-0 rounded-lg border object-cover sm:h-16 sm:w-16"
                />
              ) : (
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border bg-slate-100 text-base font-bold text-slate-700 sm:h-16 sm:w-16 sm:text-lg">
                  {manufacturer.company_name.slice(0, 2).toUpperCase()}
                </div>
              )}
              <div className="min-w-0">
                <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">{manufacturer.company_name}</h1>
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

            <div className="grid gap-2 text-xs text-slate-600 sm:grid-cols-2 lg:w-96 lg:shrink-0">
              <div className="flex flex-wrap items-center gap-2">
                <Phone className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                <span className="break-words">
                  {manufacturer.contact_person} &bull; {manufacturer.phone}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Mail className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                <span className="break-all">{manufacturer.email || "—"}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Globe className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                <span className="break-all">{manufacturer.website || "—"}</span>
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
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Company Photographs (Internal Only)
              </h3>
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
                {uploadingPhotos ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                <span>Upload Company Images</span>
                <input type="file" accept={RASTER_IMAGE_ACCEPT} multiple className="hidden" onChange={handleGalleryUpload} />
              </label>
            </div>
            {galleryUrls.length > 0 ? (
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-6">
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
            {mfgLivePriceUpdateTargets.length > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-blue-200 text-blue-700 hover:bg-blue-50 hover:text-blue-800"
                disabled={bulkPublishAction !== null}
                onClick={handleUpdatePublishedPrices}
                title="Update live Customer Portal prices for published products without publishing Draft items"
              >
                {bulkPublishAction === "update_live" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {`Update Published Prices (${mfgLivePriceUpdateTargets.length})`}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="border-emerald-200 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
              disabled={bulkPublishAction !== null || mfgDraftTargets.length === 0}
              onClick={handlePublishAllManufacturerProducts}
            >
              {bulkPublishAction === "publish" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Globe className="h-4 w-4" />
              )}
              {hasActiveMfgFilters
                ? `Publish Filtered (${mfgDraftTargets.length})`
                : `Publish All (${mfgDraftTargets.length})`}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="border-amber-200 text-amber-700 hover:bg-amber-50 hover:text-amber-800"
              disabled={bulkPublishAction !== null || mfgPublishedTargets.length === 0}
              onClick={handleUnpublishAllManufacturerProducts}
            >
              {bulkPublishAction === "unpublish" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <GlobeLock className="h-4 w-4" />
              )}
              {hasActiveMfgFilters
                ? `Unpublish Filtered (${mfgPublishedTargets.length})`
                : `Unpublish All (${mfgPublishedTargets.length})`}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setImportFeedback(null);
                setImportOpen(true);
              }}
            >
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

          <div className="divide-y divide-slate-100 rounded-md border border-slate-200 md:hidden">
            {loadingProducts ? (
              <div className="py-8 text-center text-sm text-slate-500">Loading products...</div>
            ) : filteredProducts.length === 0 ? (
              <div className="py-8 text-center text-sm text-slate-500">No products added for this manufacturer yet.</div>
            ) : (
              filteredProducts.map((p) => {
                const avail = Number(p.inventory?.available_quantity ?? 0);
                const lowThresh = Number(p.inventory?.low_stock_threshold ?? 10);
                const stockStat = avail <= 0 ? "out_of_stock" : avail <= lowThresh ? "low_stock" : "in_stock";
                const sortedPhotos = sortProductImages(p.product_images);
                const thumb = sortedPhotos[0]?.image_url;

                return (
                  <div key={p.id} className="space-y-2.5 p-3.5 text-xs">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 flex-1 items-center gap-2.5">
                        <button
                          type="button"
                          onClick={() => setPhotoProduct(p)}
                          title={thumb ? "Manage product photos" : "Add product photo"}
                          className="relative h-10 w-10 shrink-0 overflow-hidden rounded-md border bg-slate-50"
                        >
                          {thumb ? (
                            <img src={thumb} alt={p.name} className="h-full w-full object-cover" />
                          ) : (
                            <span className="flex h-full w-full items-center justify-center text-slate-400">
                              <Camera className="h-3.5 w-3.5" />
                            </span>
                          )}
                        </button>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-slate-900">{p.name}</p>
                          <p className="truncate font-mono text-slate-500">
                            {p.sku} &bull; {p.category?.name}
                          </p>
                        </div>
                      </div>
                      <StatusBadge
                        status={p.status === "inactive" ? "inactive" : p.is_published ? "published" : "draft"}
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-slate-600">
                      <span>Orig: {formatCurrency(p.product_prices?.draft_manufacturer_price ?? 0, sym)}</span>
                      <span>Margin: {p.product_prices?.draft_margin_percentage ?? 0}%</span>
                      <span className="font-semibold text-blue-700">
                        Sell: {formatCurrency(p.product_prices?.draft_selling_price ?? 0, sym)}
                      </span>
                      <span>
                        Stock: {formatQty(avail)} {p.unit_of_measurement}
                      </span>
                      <StatusBadge status={stockStat} />
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-1 border-t border-slate-100 pt-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => setPhotoProduct(p)}
                      >
                        <Camera className="h-3.5 w-3.5 text-blue-700" />
                        <span>{sortedPhotos.length > 0 ? `Photos (${sortedPhotos.length})` : "Add Photo"}</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleToggleProductPublish(p)}
                        title={p.is_published ? "Unpublish" : "Publish"}
                      >
                        {p.is_published ? <GlobeLock className="h-4 w-4 text-amber-600" /> : <Globe className="h-4 w-4 text-emerald-600" />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
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
                        onClick={() => {
                          setEditingProduct(p);
                          setDuplicateMode(true);
                          setProductDialogOpen(true);
                        }}
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="text-red-600" onClick={() => handleDeleteProduct(p)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="hidden md:block">
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
                  const sortedPhotos = sortProductImages(p.product_images);
                  const thumb = sortedPhotos[0]?.image_url;

                  return (
                    <TableRow key={p.id}>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-3">
                          <button
                            type="button"
                            onClick={() => setPhotoProduct(p)}
                            title={thumb ? "Manage product photos" : "Add product photo"}
                            className="group relative h-10 w-10 shrink-0 overflow-hidden rounded-md border bg-slate-50 transition-colors hover:border-blue-500"
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
                                <Camera className="h-3 w-3" />
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
                      <TableCell className="font-medium text-slate-900">
                        {formatCurrency(p.product_prices?.draft_manufacturer_price ?? 0, sym)}
                      </TableCell>
                      <TableCell className="text-xs text-slate-600">
                        {p.product_prices?.draft_margin_percentage ?? 0}% (
                        {formatCurrency(p.product_prices?.draft_margin_amount ?? 0, sym)})
                      </TableCell>
                      <TableCell className="font-semibold text-blue-700">
                        <div>
                          <span>{formatCurrency(p.product_prices?.draft_selling_price ?? 0, sym)}</span>
                          {p.product_prices?.approval_status === "pending_review" && (
                            <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                              Draft
                            </span>
                          )}
                        </div>
                        {isPublishedWithPendingPrice(p) && (
                          <p className="text-[11px] font-normal text-slate-500">
                            Live: {formatCurrency(p.product_prices?.published_selling_price ?? 0, sym)}
                          </p>
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
                        <div className="flex flex-col gap-1">
                          <StatusBadge
                            status={p.status === "inactive" ? "inactive" : p.is_published ? "published" : "draft"}
                          />
                          {p.status === "inactive" && p.is_published && (
                            <span className="text-[10px] text-slate-500">Hidden while inactive</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="inline-flex items-center gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 shrink-0 whitespace-nowrap px-2 text-xs"
                            title={sortedPhotos.length > 0 ? "Manage Photos" : "Add Photo"}
                            onClick={() => setPhotoProduct(p)}
                          >
                            <Camera className="h-3.5 w-3.5 text-blue-700" />
                            <span>{sortedPhotos.length > 0 ? `Photos (${sortedPhotos.length})` : "Add Photo"}</span>
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleToggleProductPublish(p)}
                            title={p.is_published ? "Unpublish from Customer Catalog" : "Publish to Customer Catalog"}
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
          </div>
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
                    <SelectItem value="fixed">Fixed Amount (+/- {sym})</SelectItem>
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
      <Dialog
        open={importOpen}
        onOpenChange={(open) => {
          if (importing && !open) return;
          if (!open) setImportFeedback(null);
          setImportOpen(open);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Bulk Excel Product Import</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              Upload an Excel (<code>.xlsx</code> / <code>.csv</code>) file containing columns:{" "}
              <code className="break-words text-xs">
                name, sku, category_name, description, unit_of_measurement, min_order_quantity, hsn_code, gst_rate,
                manufacturer_price, available_quantity
              </code>
              . Common column headers like <code>Product Name</code>, <code>Category</code>, <code>Price</code>, and{" "}
              <code>Stock</code> are also recognized.
            </p>

            <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-slate-200 bg-slate-50/70 p-3 text-xs text-slate-800">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                checked={autoCreateCategories}
                onChange={(e) => setAutoCreateCategories(e.target.checked)}
                disabled={importing}
              />
              <span>
                <strong>Automatically create new categories found in the spreadsheet</strong> and link them to this
                manufacturer (recommended).
              </span>
            </label>

            {importFeedback && (
              <div
                className={`space-y-1.5 rounded-md border p-3 text-xs ${
                  importFeedback.kind === "error"
                    ? "border-red-200 bg-red-50 text-red-900"
                    : importFeedback.kind === "warning"
                      ? "border-amber-200 bg-amber-50 text-amber-950"
                      : "border-emerald-200 bg-emerald-50 text-emerald-950"
                }`}
              >
                <p className="font-semibold">{importFeedback.summary}</p>
                {importFeedback.details.length > 0 && (
                  <ul className="max-h-40 list-disc space-y-0.5 overflow-y-auto pl-4">
                    {importFeedback.details.map((detail, idx) => (
                      <li key={idx} className="break-words">
                        {detail}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" size="sm" onClick={downloadImportTemplate} disabled={importing}>
                Download Template (.xlsx)
              </Button>
              <label
                className={`inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-xs font-medium text-white ${
                  importing ? "cursor-not-allowed opacity-70" : "cursor-pointer hover:bg-primary/90"
                }`}
              >
                {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                <span>{importing ? "Importing Products..." : "Select Excel File"}</span>
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  disabled={importing}
                  onChange={handleExcelImport}
                />
              </label>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
