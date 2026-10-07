"use client";

import { useCallback, useId, useRef, useState } from "react";
import { ACCEPTED_ACCEPT_ATTR, ACCEPTED_MIME_TYPES } from "@/lib/image";

export interface UploadZoneProps {
  /** Called with the newly picked/dropped files, already filtered by type. */
  onFiles: (files: File[]) => void;
  /** When true, the zone is inert (e.g. the max image count is reached). */
  disabled?: boolean;
  /** Copy for the explanatory line under the title. */
  hint?: string;
  disabledLabel?: string;
}

const REJECT_MESSAGE = "只支持 JPG 和 PNG 图片，其它文件已忽略。";

/**
 * Drag-and-drop + click-to-select image picker, dressed as a camera
 * viewfinder: dashed frame, corner focus marks, pixel camera glyph.
 *
 * Accepts only image/jpeg and image/png; anything else is reported to the user
 * through local state instead of being silently forwarded.
 */
export default function UploadZone({
  onFiles,
  disabled = false,
  hint,
  disabledLabel = "暂时不能添加照片",
}: UploadZoneProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState(false);

  const handleFiles = useCallback(
    (list: FileList | null) => {
      if (disabled || !list || list.length === 0) return;
      const all = Array.from(list);
      const accepted = all.filter((file) =>
        (ACCEPTED_MIME_TYPES as readonly string[]).includes(file.type),
      );
      setRejected(accepted.length !== all.length);
      if (accepted.length > 0) {
        onFiles(accepted);
      }
    },
    [disabled, onFiles],
  );

  const openPicker = useCallback(() => {
    if (disabled) return;
    inputRef.current?.click();
  }, [disabled]);

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragging(false);
      if (disabled) return;
      handleFiles(event.dataTransfer?.files ?? null);
    },
    [disabled, handleFiles],
  );

  const onDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (disabled) return;
      setDragging(true);
    },
    [disabled],
  );

  const onDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
        event.preventDefault();
        openPicker();
      }
    },
    [openPicker],
  );

  const className = [
    "frame",
    dragging ? "is-dragging" : "",
    disabled ? "is-disabled" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="stack">
      <div
        className={className}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        aria-label="添加试卷照片"
        onClick={openPicker}
        onKeyDown={onKeyDown}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
      >
        <span className="corners" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
        <span className="cam" aria-hidden="true" />
        <b>{disabled ? disabledLabel : "选择练习卷照片"}</b>
        <small>{hint ?? "也可以把照片直接拖进来。支持 JPG、PNG。"}</small>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept={ACCEPTED_ACCEPT_ATTR}
          multiple
          disabled={disabled}
          onChange={(event) => {
            handleFiles(event.target.files);
            // Allow re-picking the same file after a removal.
            event.target.value = "";
          }}
        />
      </div>

      {rejected ? (
        <div className="alert alert-warn" role="status">
          {REJECT_MESSAGE}
        </div>
      ) : null}
    </div>
  );
}