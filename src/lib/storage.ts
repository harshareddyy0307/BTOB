import { supabase } from "@/lib/supabase";

export type StorageBucket = "brand-assets" | "product-images" | "manufacturer-assets";

export const RASTER_IMAGE_ACCEPT =
  "image/png,image/jpeg,image/webp,image/gif,image/avif,.png,.jpg,.jpeg,.webp,.gif,.avif";

export const MANUFACTURER_INVOICE_ACCEPT =
  "image/png,image/jpeg,image/webp,application/pdf,.png,.jpg,.jpeg,.webp,.pdf";

const RASTER_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/avif",
]);

const RASTER_IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif"]);

const MANUFACTURER_ASSET_MIMES = new Set([...RASTER_IMAGE_MIMES, "application/pdf"]);
const MANUFACTURER_ASSET_EXTS = new Set([...RASTER_IMAGE_EXTS, "pdf"]);

const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  pdf: "application/pdf",
};

const MAX_PUBLIC_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_MANUFACTURER_ASSET_BYTES = 25 * 1024 * 1024;

export function validateStorageUploadFile(bucket: StorageBucket, file: File): { ext: string; contentType: string } {
  const ext = (file.name.split(".").pop() || "").trim().toLowerCase();
  const mime = (file.type || "").trim().toLowerCase();

  if (mime === "image/svg+xml" || ext === "svg" || mime.includes("svg") || mime.includes("html")) {
    throw new Error("SVG and HTML files are blocked for security. Please upload PNG, JPG, WEBP, GIF, or AVIF.");
  }

  if (bucket === "manufacturer-assets") {
    if (file.size > MAX_MANUFACTURER_ASSET_BYTES) {
      throw new Error("File is too large. Maximum size is 25 MB.");
    }
    const mimeOk = mime ? MANUFACTURER_ASSET_MIMES.has(mime) : true;
    const extOk = ext ? MANUFACTURER_ASSET_EXTS.has(ext) : mimeOk;
    if (!mimeOk || !extOk) {
      throw new Error("Allowed formats: PNG, JPG, WEBP, GIF, AVIF, or PDF.");
    }
    const resolvedExt = ext && MANUFACTURER_ASSET_EXTS.has(ext) ? ext : mime === "application/pdf" ? "pdf" : "jpg";
    const resolvedMime = EXT_TO_MIME[resolvedExt] || (mimeOk && mime ? mime : "application/octet-stream");
    return { ext: resolvedExt, contentType: resolvedMime };
  }

  if (file.size > MAX_PUBLIC_IMAGE_BYTES) {
    throw new Error("Image is too large. Maximum size is 15 MB.");
  }

  const mimeOk = mime ? RASTER_IMAGE_MIMES.has(mime) : true;
  const extOk = ext ? RASTER_IMAGE_EXTS.has(ext) : mimeOk;
  if (!mimeOk || !extOk || (!mime && !ext)) {
    throw new Error("Only raster image files (PNG, JPG, WEBP, GIF, AVIF) are allowed.");
  }

  const resolvedExt =
    ext && RASTER_IMAGE_EXTS.has(ext)
      ? ext
      : mime === "image/png"
        ? "png"
        : mime === "image/webp"
          ? "webp"
          : mime === "image/gif"
            ? "gif"
            : mime === "image/avif"
              ? "avif"
              : "jpg";
  const resolvedMime = EXT_TO_MIME[resolvedExt] || "image/jpeg";
  return { ext: resolvedExt, contentType: resolvedMime };
}

export async function uploadStorageFile(
  bucket: StorageBucket,
  folder: string,
  file: File
): Promise<{ path: string; url: string }> {
  const { ext, contentType } = validateStorageUploadFile(bucket, file);
  const safeFolder = folder.replace(/[^a-zA-Z0-9/_-]/g, "-").replace(/^\/+|\/+$/g, "") || "uploads";
  const safeName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const path = `${safeFolder}/${safeName}`;

  const { error } = await supabase.storage.from(bucket).upload(path, file, {
    cacheControl: "3600",
    upsert: true,
    contentType,
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

export function extractStoragePathFromPublicUrl(bucket: StorageBucket, publicUrl: string): string | null {
  if (!publicUrl || !publicUrl.startsWith("http")) return null;
  try {
    const u = new URL(publicUrl);
    const marker = `/storage/v1/object/public/${bucket}/`;
    const idx = u.pathname.indexOf(marker);
    if (idx === -1) return null;
    return decodeURIComponent(u.pathname.slice(idx + marker.length));
  } catch {
    return null;
  }
}

export async function removeStorageObjectsByPublicUrls(bucket: StorageBucket, urls: string[]): Promise<void> {
  const paths = Array.from(
    new Set(
      urls
        .map((url) => extractStoragePathFromPublicUrl(bucket, url))
        .filter((p): p is string => Boolean(p))
    )
  );
  if (paths.length === 0) return;
  try {
    await supabase.storage.from(bucket).remove(paths);
  } catch {
    // Non-fatal storage cleanup
  }
}

export async function getManufacturerAssetSignedUrl(pathOrUrl: string): Promise<string> {
  if (!pathOrUrl) return "";
  if (pathOrUrl.startsWith("http")) return pathOrUrl;
  const { data } = await supabase.storage.from("manufacturer-assets").createSignedUrl(pathOrUrl, 3600);
  return data?.signedUrl || "";
}
