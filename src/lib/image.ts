/**
 * Client-side image downscaling.
 *
 * Phone cameras produce 4–12 MB photos. Uploading those raw would blow up the
 * request size and the vision model's token budget for no accuracy gain, so we
 * shrink the longest edge to at most `maxEdge` and re-encode as JPEG.
 *
 * Browser-only: uses `document`, `Image` and `HTMLCanvasElement`.
 */

const JPEG_QUALITY = 0.85;
const DEFAULT_MAX_EDGE = 2000;

export const ACCEPTED_MIME_TYPES = ["image/jpeg", "image/png"] as const;

export const ACCEPTED_ACCEPT_ATTR = "image/jpeg,image/png";

export interface DownscaleResult {
  blob: Blob;
  filename: string;
  width: number;
  height: number;
}

export class ImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageError";
  }
}

function isAcceptedType(type: string): boolean {
  return (ACCEPTED_MIME_TYPES as readonly string[]).includes(type);
}

/** Replace the extension with .jpg; keep the stem so ordering stays readable. */
function jpegName(original: string): string {
  const base = (original || "photo").split(/[\\/]/).pop() || "photo";
  const stem = base.replace(/\.[^.]*$/, "") || "photo";
  return `${stem}.jpg`;
}

/** Load a File into a decoded HTMLImageElement. */
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new ImageError(`图片无法读取：${file.name}`));
    };
    img.src = url;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
          return;
        }
        reject(new ImageError("图片压缩失败"));
      },
      "image/jpeg",
      quality,
    );
  });
}

/**
 * Downscale an image File so its longest edge is at most `maxEdge` pixels and
 * re-encode it as JPEG at quality 0.85.
 *
 * Images already within the limit are still re-encoded, so the upload always
 * carries a predictable format and a much smaller payload than a phone HEIC/JPEG.
 * Only image/jpeg and image/png are accepted.
 */
export async function downscaleImage(
  file: File,
  maxEdge: number = DEFAULT_MAX_EDGE,
): Promise<DownscaleResult> {
  if (!file || file.size === 0) {
    throw new ImageError("图片文件是空的，请重新选择。");
  }
  if (!isAcceptedType(file.type)) {
    throw new ImageError(`只支持 JPG 和 PNG 图片：${file.name}`);
  }

  const limit = Number.isFinite(maxEdge) && maxEdge > 0 ? maxEdge : DEFAULT_MAX_EDGE;
  const img = await loadImage(file);

  const naturalWidth = img.naturalWidth || img.width;
  const naturalHeight = img.naturalHeight || img.height;
  if (naturalWidth === 0 || naturalHeight === 0) {
    throw new ImageError(`图片尺寸异常：${file.name}`);
  }

  const longest = Math.max(naturalWidth, naturalHeight);
  const scale = longest > limit ? limit / longest : 1;

  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new ImageError("当前浏览器不支持图片压缩。");
  }

  // White matte: PNGs with transparency would otherwise turn black in JPEG.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, width, height);

  const blob = await canvasToBlob(canvas, JPEG_QUALITY);

  return {
    blob,
    filename: jpegName(file.name),
    width,
    height,
  };
}
