import { supabase } from "@/lib/supabase";

export type StorageBucket = "brand-assets" | "product-images" | "manufacturer-assets";

export async function uploadStorageFile(
  bucket: StorageBucket,
  folder: string,
  file: File
): Promise<{ path: string; url: string }> {
  const ext = file.name.split(".").pop()?.toLowerCase() || "bin";
  const safeName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const path = `${folder}/${safeName}`;

  const { error } = await supabase.storage.from(bucket).upload(path, file, {
    cacheControl: "3600",
    upsert: true,
    contentType: file.type || undefined,
  });

  if (error) {
    throw new Error(error.message);
  }

  if (bucket === "manufacturer-assets") {
    // Private bucket — store storage path or create signed URL on demand
    const { data: signed } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60 * 24 * 7);
    return { path, url: signed?.signedUrl || path };
  }

  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return { path, url: data.publicUrl };
}

export async function getManufacturerAssetSignedUrl(pathOrUrl: string): Promise<string> {
  if (!pathOrUrl) return "";
  if (pathOrUrl.startsWith("http")) return pathOrUrl;
  const { data } = await supabase.storage.from("manufacturer-assets").createSignedUrl(pathOrUrl, 3600);
  return data?.signedUrl || "";
}
