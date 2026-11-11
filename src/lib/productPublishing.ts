import type { QueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { AdminProduct } from "@/types/database";

const CHUNK_SIZE = 50;

export async function invalidateCatalogQueries(queryClient: QueryClient) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["admin-all-products"] }),
    queryClient.invalidateQueries({ queryKey: ["admin-manufacturer-products"] }),
    queryClient.invalidateQueries({ queryKey: ["admin-pricing-products"] }),
    queryClient.invalidateQueries({ queryKey: ["admin-price-history"] }),
    queryClient.invalidateQueries({ queryKey: ["customer-home-catalog"] }),
    queryClient.invalidateQueries({ queryKey: ["customer-all-products"] }),
    queryClient.invalidateQueries({ queryKey: ["customer-category-products"] }),
    queryClient.invalidateQueries({ queryKey: ["customer-product-detail"] }),
    queryClient.invalidateQueries({ queryKey: ["customer-cart"] }),
  ]);
}

export async function bulkPublishProducts(
  products: AdminProduct[],
  queryClient: QueryClient,
  options?: { includePublishedPendingPrice?: boolean }
): Promise<{ publishedCount: number; skippedZeroPriceCount: number }> {
  const candidates = options?.includePublishedPendingPrice
    ? products.filter((p) => !p.is_published || p.product_prices?.approval_status === "pending_review")
    : products.filter((p) => !p.is_published);

  if (candidates.length === 0) {
    return { publishedCount: 0, skippedZeroPriceCount: 0 };
  }

  const publishable = candidates.filter((p) => Number(p.product_prices?.draft_selling_price ?? 0) > 0);
  const skippedZeroPriceCount = candidates.length - publishable.length;

  let publishedCount = 0;
  for (let i = 0; i < publishable.length; i += CHUNK_SIZE) {
    const chunkIds = publishable.slice(i, i + CHUNK_SIZE).map((p) => p.id);
    const { data: count, error } = await supabase.rpc("publish_product_prices", {
      p_product_ids: chunkIds,
      p_mark_products_published: true,
    });
    if (error) throw error;
    publishedCount += Number(count ?? chunkIds.length);
  }

  if (publishedCount > 0) {
    await invalidateCatalogQueries(queryClient);
  }

  return { publishedCount, skippedZeroPriceCount };
}

export async function bulkUnpublishProducts(
  products: AdminProduct[],
  actorUserId: string | undefined,
  queryClient: QueryClient
): Promise<{ unpublishedCount: number }> {
  const published = products.filter((p) => p.is_published);
  if (published.length === 0) {
    return { unpublishedCount: 0 };
  }

  for (let i = 0; i < published.length; i += CHUNK_SIZE) {
    const chunkIds = published.slice(i, i + CHUNK_SIZE).map((p) => p.id);
    const { error } = await supabase.from("products").update({ is_published: false }).in("id", chunkIds);
    if (error) throw error;
  }

  if (actorUserId) {
    await supabase.from("audit_logs").insert({
      actor_user_id: actorUserId,
      action: "bulk_unpublish_products",
      entity_type: "products",
      entity_id: "bulk",
      new_data: { count: published.length },
    });
  }

  await invalidateCatalogQueries(queryClient);
  return { unpublishedCount: published.length };
}
