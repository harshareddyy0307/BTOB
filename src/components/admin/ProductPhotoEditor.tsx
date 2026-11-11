import React, { useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ImagePlus,
  Link2,
  Loader2,
  Star,
  Trash2,
  Upload,
} from "lucide-react";
import { uploadStorageFile } from "@/lib/storage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";

export interface ProductPhotoDraft {
  image_url: string;
  is_primary: boolean;
}

interface ProductPhotoEditorProps {
  photos: ProductPhotoDraft[];
  onChange: (next: ProductPhotoDraft[]) => void;
  storageFolder?: string;
  compact?: boolean;
}

export function ProductPhotoEditor({
  photos,
  onChange,
  storageFolder = "catalog",
  compact = false,
}: ProductPhotoEditorProps) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [showUrlInput, setShowUrlInput] = useState(false);

  const processFiles = async (fileList: FileList | File[]) => {
    const candidates = Array.from(fileList);
    if (candidates.length === 0) return;

    const imageFiles = candidates.filter(
      (f) => f.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|avif|svg)$/i.test(f.name)
    );
    if (imageFiles.length === 0) {
      toast({
        title: "Unsupported file type",
        description: "Please choose PNG, JPG, WEBP, GIF, or AVIF image files.",
        type: "error",
      });
      return;
    }

    setUploading(true);
    try {
      const uploaded: ProductPhotoDraft[] = [];
      for (const file of imageFiles) {
        const { url } = await uploadStorageFile("product-images", storageFolder, file);
        uploaded.push({
          image_url: url,
          is_primary: photos.length === 0 && uploaded.length === 0,
        });
      }
      onChange([...photos, ...uploaded]);
      toast({
        title: `${uploaded.length} product photo${uploaded.length > 1 ? "s" : ""} uploaded`,
        type: "success",
      });
    } catch (err) {
      toast({
        title: "Photo upload failed",
        description: err instanceof Error ? err.message : "Could not upload image",
        type: "error",
      });
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      void processFiles(e.target.files);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (uploading) return;
    if (e.dataTransfer.files?.length) {
      void processFiles(e.dataTransfer.files);
    }
  };

  const handleAddUrl = () => {
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    if (!/^https?:\/\/\S+/i.test(trimmed)) {
      toast({
        title: "Invalid image URL",
        description: "Enter a full URL starting with http:// or https://",
        type: "error",
      });
      return;
    }
    const next: ProductPhotoDraft[] = [
      ...photos,
      { image_url: trimmed, is_primary: photos.length === 0 },
    ];
    onChange(next);
    setUrlInput("");
    setShowUrlInput(false);
    toast({ title: "Image URL added", type: "success" });
  };

  const setPrimary = (idx: number) => {
    onChange(photos.map((img, i) => ({ ...img, is_primary: i === idx })));
  };

  const movePhoto = (idx: number, direction: -1 | 1) => {
    const target = idx + direction;
    if (target < 0 || target >= photos.length) return;
    const copy = [...photos];
    const [item] = copy.splice(idx, 1);
    copy.splice(target, 0, item);
    onChange(copy);
  };

  const removePhoto = (idx: number) => {
    const next = photos.filter((_, i) => i !== idx);
    if (next.length > 0 && !next.some((p) => p.is_primary)) {
      next[0] = { ...next[0], is_primary: true };
    }
    onChange(next);
  };

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/70 p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Label className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
            <ImagePlus className="h-4 w-4 text-blue-700" />
            Product Photos ({photos.length})
          </Label>
          <p className="text-[11px] text-slate-500">
            Upload one or more photos. The photo marked <strong>Cover</strong> appears on product cards and customer orders.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-slate-600"
            onClick={() => setShowUrlInput((s) => !s)}
          >
            <Link2 className="h-3.5 w-3.5" />
            {showUrlInput ? "Hide URL" : "Add by URL"}
          </Button>
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-blue-700 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-blue-800">
            {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            <span>{uploading ? "Uploading..." : "Add Photo"}</span>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              disabled={uploading}
              onChange={handleFileChange}
            />
          </label>
        </div>
      </div>

      {showUrlInput && (
        <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-white p-2">
          <Input
            type="url"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleAddUrl();
              }
            }}
            placeholder="https://example.com/product-photo.jpg"
            className="h-8 text-xs"
          />
          <Button type="button" size="sm" variant="outline" className="h-8 shrink-0 text-xs" onClick={handleAddUrl}>
            Add URL
          </Button>
        </div>
      )}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => {
          if (!uploading) fileInputRef.current?.click();
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !uploading) {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-md border-2 border-dashed bg-white px-4 text-center transition-colors ${
          compact ? "py-3" : "py-4"
        } ${
          dragOver
            ? "border-blue-600 bg-blue-50/70"
            : "border-slate-300 hover:border-blue-400 hover:bg-slate-50/80"
        }`}
      >
        {uploading ? (
          <div className="flex items-center gap-2 text-xs font-medium text-blue-700">
            <Loader2 className="h-4 w-4 animate-spin" />
            Uploading product photo(s)...
          </div>
        ) : (
          <p className="text-xs text-slate-600">
            <span className="font-semibold text-blue-700">Click to choose photos</span> or drag &amp; drop PNG, JPG, WEBP here
          </p>
        )}
      </div>

      {photos.length > 0 && (
        <div className={`grid gap-3 ${compact ? "grid-cols-3 sm:grid-cols-5" : "grid-cols-2 sm:grid-cols-4"}`}>
          {photos.map((img, i) => (
            <div
              key={`${img.image_url}-${i}`}
              className={`group relative overflow-hidden rounded-md border bg-white p-1.5 shadow-sm ${
                img.is_primary ? "border-blue-500 ring-1 ring-blue-200" : "border-slate-200"
              }`}
            >
              <div className="relative aspect-square overflow-hidden rounded bg-slate-100">
                <img src={img.image_url} alt={`Product photo ${i + 1}`} className="h-full w-full object-cover" />
                {img.is_primary && (
                  <span className="absolute left-1 top-1 rounded bg-blue-700/95 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                    Cover
                  </span>
                )}
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-1">
                <button
                  type="button"
                  onClick={() => setPrimary(i)}
                  className={`inline-flex items-center gap-1 rounded px-1 py-0.5 text-[11px] font-medium ${
                    img.is_primary
                      ? "text-amber-600"
                      : "text-slate-500 hover:bg-slate-100 hover:text-amber-600"
                  }`}
                  title="Set as primary cover photo"
                >
                  <Star className={`h-3.5 w-3.5 ${img.is_primary ? "fill-amber-500 text-amber-500" : ""}`} />
                  {!compact && <span>{img.is_primary ? "Primary" : "Set Cover"}</span>}
                </button>
                <div className="flex items-center gap-0.5">
                  {photos.length > 1 && (
                    <>
                      <button
                        type="button"
                        disabled={i === 0}
                        onClick={() => movePhoto(i, -1)}
                        className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30"
                        title="Move left"
                      >
                        <ArrowLeft className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        disabled={i === photos.length - 1}
                        onClick={() => movePhoto(i, 1)}
                        className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30"
                        title="Move right"
                      >
                        <ArrowRight className="h-3 w-3" />
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => removePhoto(i)}
                    className="rounded p-0.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                    title="Remove photo"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
