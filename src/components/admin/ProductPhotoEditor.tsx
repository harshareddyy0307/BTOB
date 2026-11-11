import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  ImagePlus,
  Link2,
  Loader2,
  RefreshCw,
  RotateCcw,
  Star,
  SwitchCamera,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  RASTER_IMAGE_ACCEPT,
  extractStoragePathFromPublicUrl,
  removeStorageObjectsByPublicUrls,
  uploadStorageFile,
  validateStorageUploadFile,
} from "@/lib/storage";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";

export interface ProductPhotoDraft {
  image_url: string;
  is_primary: boolean;
  pendingFile?: File;
}

export async function finalizeProductPhotoDrafts(
  drafts: ProductPhotoDraft[],
  storageFolder: string
): Promise<{ image_url: string; is_primary: boolean }[]> {
  const results: { image_url: string; is_primary: boolean }[] = [];
  for (const draft of drafts) {
    if (draft.pendingFile) {
      const { url } = await uploadStorageFile("product-images", storageFolder, draft.pendingFile);
      results.push({ image_url: url, is_primary: draft.is_primary });
    } else {
      results.push({ image_url: draft.image_url, is_primary: draft.is_primary });
    }
  }
  return results;
}

export async function cleanupUnusedProductStoragePhotos(
  previousUrls: string[],
  nextUrls: string[]
): Promise<void> {
  const nextSet = new Set(nextUrls);
  const removedCandidates = Array.from(
    new Set(
      previousUrls.filter(
        (u) => !nextSet.has(u) && extractStoragePathFromPublicUrl("product-images", u) !== null
      )
    )
  );
  if (removedCandidates.length === 0) return;

  try {
    const { data } = await supabase
      .from("product_images")
      .select("image_url")
      .in("image_url", removedCandidates);
    const stillReferenced = new Set((data ?? []).map((row) => row.image_url));
    const orphanedUrls = removedCandidates.filter((u) => !stillReferenced.has(u));
    if (orphanedUrls.length > 0) {
      await removeStorageObjectsByPublicUrls("product-images", orphanedUrls);
    }
  } catch {
    // Non-fatal cleanup
  }
}

interface ProductPhotoEditorProps {
  photos: ProductPhotoDraft[];
  onChange: (next: ProductPhotoDraft[]) => void;
  disabled?: boolean;
  compact?: boolean;
}

export function ProductPhotoEditor({
  photos,
  onChange,
  disabled = false,
  compact = false,
}: ProductPhotoEditorProps) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const nativeCameraInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const videoDevicesRef = useRef<MediaDeviceInfo[]>([]);
  const activeDeviceIdRef = useRef<string | null>(null);
  const cameraRequestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const capturedPreviewUrlRef = useRef<string | null>(null);
  const stagedBlobUrlsRef = useRef<Set<string>>(new Set());

  const [staging, setStaging] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [showUrlInput, setShowUrlInput] = useState(false);

  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const [hasMultipleCameras, setHasMultipleCameras] = useState(false);
  const [capturedFile, setCapturedFile] = useState<File | null>(null);
  const [capturedPreviewUrl, setCapturedPreviewUrl] = useState<string | null>(null);

  const setCapturedShot = useCallback((file: File | null, previewUrl: string | null) => {
    if (capturedPreviewUrlRef.current && capturedPreviewUrlRef.current !== previewUrl) {
      URL.revokeObjectURL(capturedPreviewUrlRef.current);
    }
    capturedPreviewUrlRef.current = previewUrl;
    setCapturedFile(file);
    setCapturedPreviewUrl(previewUrl);
  }, []);

  const stopCameraStream = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraReady(false);
  }, []);

  const closeCamera = useCallback(() => {
    cameraRequestIdRef.current += 1;
    stopCameraStream();
    setCapturedShot(null, null);
    setCameraError(null);
    setCameraStarting(false);
    setCameraOpen(false);
  }, [setCapturedShot, stopCameraStream]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cameraRequestIdRef.current += 1;
      if (streamRef.current) {
        for (const track of streamRef.current.getTracks()) {
          track.stop();
        }
        streamRef.current = null;
      }
      if (capturedPreviewUrlRef.current) {
        URL.revokeObjectURL(capturedPreviewUrlRef.current);
        capturedPreviewUrlRef.current = null;
      }
      stagedBlobUrlsRef.current.forEach((blobUrl) => {
        URL.revokeObjectURL(blobUrl);
      });
      stagedBlobUrlsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!cameraOpen || !video || !stream) return;
    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
    video.play().catch(() => {});
  }, [cameraOpen, cameraStarting, capturedPreviewUrl, cameraError]);

  const startCameraStream = useCallback(
    async (targetFacing: "environment" | "user", targetDeviceId?: string) => {
      const reqId = ++cameraRequestIdRef.current;
      stopCameraStream();
      setCapturedShot(null, null);
      setCameraError(null);
      setCameraOpen(true);
      setCameraStarting(true);

      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error(
            "Direct browser camera access is unavailable here. Use the Device Camera button or Upload Photo instead."
          );
        }

        const primaryConstraints: MediaTrackConstraints = targetDeviceId
          ? {
              deviceId: { exact: targetDeviceId },
              width: { ideal: 1920 },
              height: { ideal: 1080 },
            }
          : {
              facingMode: { ideal: targetFacing },
              width: { ideal: 1920 },
              height: { ideal: 1080 },
            };

        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: primaryConstraints,
            audio: false,
          });
        } catch (firstErr) {
          if (
            firstErr instanceof DOMException &&
            (firstErr.name === "OverconstrainedError" || firstErr.name === "ConstraintNotSatisfiedError")
          ) {
            stream = await navigator.mediaDevices.getUserMedia({
              video: true,
              audio: false,
            });
          } else {
            throw firstErr;
          }
        }

        if (!mountedRef.current || reqId !== cameraRequestIdRef.current) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }

        streamRef.current = stream;
        activeDeviceIdRef.current = stream.getVideoTracks()[0]?.getSettings()?.deviceId || targetDeviceId || null;

        if (navigator.mediaDevices.enumerateDevices) {
          try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoInputs = devices.filter((d) => d.kind === "videoinput");
            if (mountedRef.current && reqId === cameraRequestIdRef.current) {
              videoDevicesRef.current = videoInputs.filter((d) => Boolean(d.deviceId));
              setHasMultipleCameras(videoInputs.length > 1);
            }
          } catch {
            // Ignore device enumeration limits
          }
        }

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      } catch (err) {
        if (!mountedRef.current || reqId !== cameraRequestIdRef.current) return;
        let message = "Could not start camera.";
        if (err instanceof DOMException) {
          if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
            message =
              "Camera permission was blocked. Allow camera access in your browser address bar, or use Device Camera / Upload Photo below.";
          } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
            message = "No camera was found on this device. Connect a webcam or upload a photo file instead.";
          } else if (err.name === "NotReadableError" || err.name === "TrackStartError") {
            message = "Camera is currently in use by another application. Close the other app and click Retry Camera.";
          } else if (err.message) {
            message = err.message;
          }
        } else if (err instanceof Error && err.message) {
          message = err.message;
        }
        setCameraError(message);
      } finally {
        if (mountedRef.current && reqId === cameraRequestIdRef.current) {
          setCameraStarting(false);
        }
      }
    },
    [setCapturedShot, stopCameraStream]
  );

  const handleToggleCamera = () => {
    if (cameraOpen) {
      closeCamera();
    } else {
      void startCameraStream(facingMode);
    }
  };

  const handleSwitchCamera = () => {
    const nextFacing = facingMode === "environment" ? "user" : "environment";
    setFacingMode(nextFacing);
    const list = videoDevicesRef.current;
    if (list.length > 1) {
      const idx = list.findIndex((d) => d.deviceId === activeDeviceIdRef.current);
      const nextDevice = list[(idx + 1) % list.length];
      if (nextDevice?.deviceId) {
        void startCameraStream(nextFacing, nextDevice.deviceId);
        return;
      }
    }
    void startCameraStream(nextFacing);
  };

  const handleVideoReady = () => {
    const v = videoRef.current;
    if (v && v.videoWidth > 0 && v.videoHeight > 0) {
      setCameraReady(true);
    }
  };

  const handleCaptureFrame = async () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      toast({
        title: "Camera still initializing",
        description: "Wait a moment for the live camera preview before capturing.",
        type: "error",
      });
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      toast({ title: "Could not capture image", type: "error" });
      return;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) {
      toast({ title: "Failed to encode captured photo", type: "error" });
      return;
    }

    const file = new File([blob], `camera-photo-${Date.now()}.jpg`, {
      type: blob.type || "image/jpeg",
    });
    const previewUrl = URL.createObjectURL(blob);
    setCapturedShot(file, previewUrl);
  };

  const processFiles = (fileList: FileList | File[]): boolean => {
    const candidates = Array.from(fileList);
    if (candidates.length === 0) return false;

    setStaging(true);
    try {
      const staged: ProductPhotoDraft[] = [];
      let rejectedReason: string | null = null;

      for (const file of candidates) {
        try {
          validateStorageUploadFile("product-images", file);
          const previewUrl = URL.createObjectURL(file);
          stagedBlobUrlsRef.current.add(previewUrl);
          staged.push({
            image_url: previewUrl,
            is_primary: photos.length === 0 && staged.length === 0,
            pendingFile: file,
          });
        } catch (err) {
          rejectedReason = err instanceof Error ? err.message : "Unsupported file";
        }
      }

      if (staged.length === 0) {
        toast({
          title: "Unsupported image file",
          description: rejectedReason || "Please choose PNG, JPG, WEBP, GIF, or AVIF image files.",
          type: "error",
        });
        return false;
      }

      onChange([...photos, ...staged]);
      if (rejectedReason) {
        toast({
          title: `${staged.length} photo${staged.length > 1 ? "s" : ""} staged (some files skipped)`,
          description: rejectedReason,
          type: "info",
        });
      } else {
        toast({
          title: `${staged.length} photo${staged.length > 1 ? "s" : ""} staged`,
          description: "Click Save to upload and apply.",
          type: "success",
        });
      }
      return true;
    } finally {
      setStaging(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      if (nativeCameraInputRef.current) {
        nativeCameraInputRef.current.value = "";
      }
    }
  };

  const handleUseCapturedPhoto = (keepCameraOpen: boolean) => {
    if (!capturedFile) return;
    const ok = processFiles([capturedFile]);
    if (!ok) return;
    setCapturedShot(null, null);
    if (!keepCameraOpen) {
      closeCamera();
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      processFiles(e.target.files);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (staging || disabled) return;
    if (e.dataTransfer.files?.length) {
      processFiles(e.dataTransfer.files);
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
    if (/\.svg(\?|#|$)/i.test(trimmed)) {
      toast({
        title: "SVG URLs are blocked",
        description: "Please provide a direct raster image URL (PNG, JPG, WEBP, GIF, or AVIF).",
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
    const removed = photos[idx];
    if (removed && stagedBlobUrlsRef.current.has(removed.image_url)) {
      URL.revokeObjectURL(removed.image_url);
      stagedBlobUrlsRef.current.delete(removed.image_url);
    }
    const next = photos.filter((_, i) => i !== idx);
    if (next.length > 0 && !next.some((p) => p.is_primary)) {
      next[0] = { ...next[0], is_primary: true };
    }
    onChange(next);
  };

  const busy = staging || disabled;

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/70 p-3.5">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Label className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
            <ImagePlus className="h-4 w-4 text-blue-700" />
            Product Photos ({photos.length})
          </Label>
          <p className="text-[11px] text-slate-500">
            Take photos directly with your camera or upload images. The <strong>Cover</strong> photo appears on cards and orders.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
          <Button
            type="button"
            variant={cameraOpen ? "secondary" : "outline"}
            size="sm"
            className="h-8 gap-1.5 px-2.5 text-xs border-blue-200 text-blue-700 hover:bg-blue-50"
            onClick={handleToggleCamera}
            disabled={busy}
          >
            <Camera className="h-3.5 w-3.5" />
            <span>{cameraOpen ? "Close Camera" : "Take Photo"}</span>
          </Button>
          <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-blue-700 px-3 text-xs font-medium text-white shadow-sm hover:bg-blue-800">
            {staging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            <span>{staging ? "Staging..." : "Add Photo"}</span>
            <input
              ref={fileInputRef}
              type="file"
              accept={RASTER_IMAGE_ACCEPT}
              multiple
              className="hidden"
              disabled={busy}
              onChange={handleFileChange}
            />
          </label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-xs text-slate-600"
            disabled={busy}
            onClick={() => setShowUrlInput((s) => !s)}
          >
            <Link2 className="h-3.5 w-3.5" />
            {showUrlInput ? "Hide URL" : "Add by URL"}
          </Button>
          <input
            ref={nativeCameraInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            className="hidden"
            disabled={busy}
            onChange={handleFileChange}
          />
        </div>
      </div>

      {cameraOpen && (
        <div className="space-y-3 rounded-lg border border-blue-200 bg-white p-3 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-800">
              <Camera className="h-4 w-4 text-blue-700" />
              <span>{capturedPreviewUrl ? "Review Captured Photo" : "Live Camera Preview"}</span>
            </div>
            <div className="flex items-center gap-1.5">
              {hasMultipleCameras && !capturedPreviewUrl && !cameraError && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 px-2 text-xs"
                  onClick={handleSwitchCamera}
                  disabled={cameraStarting || busy}
                >
                  <SwitchCamera className="h-3.5 w-3.5" />
                  Switch Camera
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs text-slate-500"
                onClick={closeCamera}
                disabled={busy}
              >
                <X className="h-3.5 w-3.5" />
                Close
              </Button>
            </div>
          </div>

          {cameraError ? (
            <div className="space-y-3 rounded-md border border-amber-200 bg-amber-50 p-4 text-center">
              <p className="text-xs text-amber-900">{cameraError}</p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1.5 text-xs bg-white"
                  onClick={() => void startCameraStream(facingMode)}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Retry Camera
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-8 gap-1.5 text-xs"
                  onClick={() => nativeCameraInputRef.current?.click()}
                >
                  <Camera className="h-3.5 w-3.5" />
                  Use Device Camera App
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2.5">
              <div className="relative flex aspect-video max-h-72 w-full items-center justify-center overflow-hidden rounded-md border border-slate-200 bg-slate-950">
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  onLoadedMetadata={handleVideoReady}
                  onLoadedData={handleVideoReady}
                  onCanPlay={handleVideoReady}
                  onPlaying={handleVideoReady}
                  className={`h-full w-full object-contain ${capturedPreviewUrl ? "hidden" : "block"}`}
                />
                {capturedPreviewUrl && (
                  <img
                    src={capturedPreviewUrl}
                    alt="Captured product preview"
                    className="h-full w-full object-contain"
                  />
                )}
                {cameraStarting && !capturedPreviewUrl && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-slate-950/80 text-xs text-white">
                    <Loader2 className="h-5 w-5 animate-spin" />
                    <span>Starting camera...</span>
                  </div>
                )}
              </div>

              {capturedPreviewUrl ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1.5 text-xs"
                    onClick={() => setCapturedShot(null, null)}
                    disabled={busy}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Retake
                  </Button>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 gap-1.5 text-xs"
                      onClick={() => handleUseCapturedPhoto(true)}
                      disabled={busy}
                    >
                      {staging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
                      Use &amp; Take Another
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      className="h-8 gap-1.5 text-xs"
                      onClick={() => handleUseCapturedPhoto(false)}
                      disabled={busy}
                    >
                      {staging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      Use Photo
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[11px] text-slate-500">
                    Point your camera at the product and click Capture Photo.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 gap-1.5 text-xs"
                    onClick={() => void handleCaptureFrame()}
                    disabled={!cameraReady || cameraStarting || busy}
                  >
                    <Camera className="h-3.5 w-3.5" />
                    Capture Photo
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {showUrlInput && (
        <div className="flex flex-col gap-2 rounded-md border border-slate-200 bg-white p-2 sm:flex-row sm:items-center">
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

      {!cameraOpen && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => {
            if (!busy) fileInputRef.current?.click();
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === " ") && !busy) {
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
          {staging ? (
            <div className="flex items-center gap-2 text-xs font-medium text-blue-700">
              <Loader2 className="h-4 w-4 animate-spin" />
              Preparing product photo(s)...
            </div>
          ) : (
            <p className="text-xs text-slate-600">
              <span className="font-semibold text-blue-700">Click to choose photos</span> or drag &amp; drop PNG, JPG, WEBP here
            </p>
          )}
        </div>
      )}

      {photos.length > 0 && (
        <div className={`grid gap-3 ${compact ? "grid-cols-2 sm:grid-cols-5" : "grid-cols-2 sm:grid-cols-4"}`}>
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
                {img.pendingFile && (
                  <span className="absolute bottom-1 left-1 rounded bg-amber-600/95 px-1.5 py-0.5 text-[9px] font-semibold text-white">
                    Pending save
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
