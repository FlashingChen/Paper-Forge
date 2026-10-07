"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DocxPreview, PreviewNotices } from "@/components/DocxPreview";
import type { PreviewDoc } from "@/lib/preview-types";

export interface PreviewOverlayProps {
  doc: PreviewDoc;
  downloadHref: string;
  onClose: () => void;
}


const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

const ZOOM_STEP = 1.25;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}


export default function PreviewOverlay({
  doc,
  downloadHref,
  onClose,
}: PreviewOverlayProps) {
  const [zoom, setZoom] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const fitScaleRef = useRef(1);
  const effectiveZoom = zoom ?? fitScaleRef.current;


  const offsetX = useCallback(() => {
    const body = bodyRef.current;
    const scaler = body?.querySelector(".pf-scaler") as HTMLElement | null;
    if (!body || !scaler) return 0;
    return Math.max(0, (body.clientWidth - scaler.offsetWidth) / 2);
  }, []);


  const pendingAnchorRef = useRef<{
    ax: number;
    ay: number;
    contentX: number;
    contentY: number;
  } | null>(null);

  const zoomTo = useCallback(
    (next: number, anchor?: { x: number; y: number }) => {
      const body = bodyRef.current;
      const target = clampZoom(next);
      if (!body) {
        setZoom(target);
        return;
      }
      const ax = anchor?.x ?? body.clientWidth / 2;
      const ay = anchor?.y ?? body.clientHeight / 2;
      const from = zoom ?? fitScaleRef.current;
      pendingAnchorRef.current = {
        ax,
        ay,
        contentX: (body.scrollLeft + ax - offsetX()) / from,
        contentY: (body.scrollTop + ay) / from,
      };

      setZoom(target);
    },
    [offsetX, zoom],
  );

  useLayoutEffect(() => {
    const pending = pendingAnchorRef.current;
    const body = bodyRef.current;
    pendingAnchorRef.current = null;
    if (!pending || !body || zoom === null) return;

    body.scrollLeft = pending.contentX * zoom + offsetX() - pending.ax;
    body.scrollTop = pending.contentY * zoom - pending.ay;
  }, [zoom, offsetX]);

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      const zoomIn = event.key === "+" || event.key === "=";
      const zoomOut = event.key === "-" || event.key === "_";
      if ((zoomIn || zoomOut) && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        zoomTo(effectiveZoom * (zoomIn ? ZOOM_STEP : 1 / ZOOM_STEP));
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        setZoom(null); // back to fit
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [effectiveZoom, onClose, zoomTo]);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return undefined;

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return; // a plain wheel scrolls
      event.preventDefault();
      const rect = body.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY / 320);
      zoomTo(effectiveZoom * factor, {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };

    body.addEventListener("wheel", onWheel, { passive: false });
    return () => body.removeEventListener("wheel", onWheel);
  }, [effectiveZoom, zoomTo]);

  return (
    <div
      className="pf-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="文档预览"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="pf-overlay-panel">
        <div className="pf-overlay-head">
          <div className="pf-overlay-acts">
            <button
              type="button"
              className="pf-btn pf-zoom"
              onClick={() => zoomTo(effectiveZoom / ZOOM_STEP)}
              disabled={effectiveZoom <= MIN_ZOOM + 0.001}
              aria-label="缩小"
              title="缩小（-）"
            >
              −
            </button>
            <button
              type="button"
              className="pf-btn pf-zoom-label"
              onClick={() => setZoom(zoom === null ? 1 : null)}
              title={
                zoom === null
                  ? "当前按宽度自适应，点一下按 100% 显示"
                  : "点一下回到适配宽度"
              }
            >
              {zoom === null ? "适配" : `${Math.round(effectiveZoom * 100)}%`}
            </button>
            <button
              type="button"
              className="pf-btn pf-zoom"
              onClick={() => zoomTo(effectiveZoom * ZOOM_STEP)}
              disabled={effectiveZoom >= MAX_ZOOM - 0.001}
              aria-label="放大"
              title="放大（+，或 ⌘/Ctrl + 滚轮）"
            >
              +
            </button>
            <a className="pf-btn" href={downloadHref} download title="下载 Word 文档">
              下载
            </a>
            <button
              type="button"
              className="pf-btn danger"
              onClick={onClose}
              ref={closeRef}
              aria-label="关闭预览"
              title="关闭（Esc）"
            >
              ✕
            </button>
          </div>
          {/* Only real problems get a line here: this view is the paper, not a
              place to explain itself. */}
          <PreviewNotices doc={doc} />
        </div>

        <div className="pf-overlay-body" ref={bodyRef}>
          <DocxPreview
            doc={doc}
            variant="fit"
            scale={zoom ?? undefined}
            onScaleChange={(value) => {
              fitScaleRef.current = value;
            }}
          />
        </div>
      </div>
    </div>
  );
}
