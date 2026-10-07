"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type {
  PreviewBlock,
  PreviewDoc,
  PreviewParagraph,
  PreviewRun,
  PreviewTable,
} from "@/lib/preview-types";

/**
 * Paints the preview payload as an A4 sheet.
 *
 * This is deliberately a *re-render*, not Word: the browser lays the text out
 * again, so it can differ from Word in fonts (whatever the reader's machine
 * has), in line breaking, and above all in where pages end. The contract the
 * UI promises is narrower and honest — the TEXT and the STRUCTURE are exactly
 * what is in the .docx, because both come from the same file (PreviewStats
 * counts characters straight out of the XML).
 *
 * Everything here is plain React text nodes: no dangerouslySetInnerHTML, so
 * document content can never become markup.
 */

/** CSS px per millimetre at 96dpi; used to report geometry back in mm. */
const PX_PER_MM = 96 / 25.4;

/**
 * Word font name -> a stack that has a chance of existing locally.
 *
 * The .docx asks for 宋体/楷体 by name. Those ship with Windows and Office;
 * macOS and Linux usually do not have them, and a browser silently substitutes
 * whatever CJK font it likes. Mapping only widens the candidate list — the
 * font name in the document is never rewritten.
 */
export function cssFont(name: string): string {
  const key = name.trim().toLowerCase();
  if (/^(宋体|simsun|nsimsun|songti|宋体-简)/.test(key)) {
    return '"SimSun", "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", serif';
  }
  if (/^(楷体|kaiti|stkaiti|楷体-简)/.test(key)) {
    return '"KaiTi", "Kaiti SC", "STKaiti", "Noto Serif CJK SC", serif';
  }
  if (/^(仿宋|fangsong|stfangsong)/.test(key)) {
    return '"FangSong", "STFangsong", "Songti SC", serif';
  }
  if (/^(黑体|simhei|heiti|微软雅黑|microsoft yahei)/.test(key)) {
    return '"SimHei", "Heiti SC", "Microsoft YaHei", sans-serif';
  }
  const cleaned = name.replace(/["\\]/g, "").trim();
  return cleaned ? `"${cleaned}", serif` : "serif";
}

function runStyle(run: PreviewRun): CSSProperties {
  const style: CSSProperties = {
    fontFamily: cssFont(run.font),
    fontSize: `${run.sizePt}pt`,
    // Word's own convention: a newline inside a run is a hard line break and
    // tabs are preserved, so pre-wrap is what reproduces the document.
    whiteSpace: "pre-wrap",
  };
  if (run.bold) style.fontWeight = 700;
  if (run.italic) style.fontStyle = "italic";
  if (run.color) style.color = run.color;
  if (run.underline) style.textDecoration = "underline";
  return style;
}

function lineHeightFor(paragraph: PreviewParagraph): string {
  // auto is a multiple of single spacing; exact/atLeast are absolute points.
  return paragraph.lineRule === "auto" ? String(paragraph.line) : `${paragraph.line}pt`;
}

function Paragraph({ paragraph }: { paragraph: PreviewParagraph }) {
  const style: CSSProperties = {
    marginTop: paragraph.spaceBeforePx,
    marginBottom: paragraph.spaceAfterPx,
    marginLeft: paragraph.indentLeftPx,
    textIndent: paragraph.indentFirstLinePx,
    textAlign: paragraph.align,
    lineHeight: lineHeightFor(paragraph),
  };

  if (paragraph.runs.length === 0) {
    // An empty paragraph still occupies a line in Word; <br /> keeps that.
    return (
      <p className="pf-p" style={style}>
        <br />
      </p>
    );
  }

  return (
    <p className="pf-p" style={style}>
      {paragraph.runs.map((run, index) => (
        <span key={index} style={runStyle(run)}>
          {run.text}
          {run.images?.map((image, imageIndex) => (
            // Embedded raster images come from the bounded DOCX extractor.
            // eslint-disable-next-line @next/next/no-img-element
            <img key={imageIndex} src={image.src} alt="题目插图"
              style={{ width: image.widthPx, maxWidth: "100%", height: "auto", verticalAlign: "middle" }} />
          ))}
        </span>
      ))}
    </p>
  );
}

function Table({ table }: { table: PreviewTable }) {
  return (
    <table className="pf-table">
      <colgroup>
        {table.widthsPx.map((width, index) => (
          <col key={index} style={{ width: `${width}px` }} />
        ))}
      </colgroup>
      <tbody>
        {table.rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.cells
              // A continuation cell is already covered by the rowSpan above.
              .filter((cell) => !cell.skip)
              .map((cell, cellIndex) => (
                <td key={cellIndex} colSpan={cell.colSpan} rowSpan={cell.rowSpan}>
                  {cell.blocks.map((block, blockIndex) => (
                    <Block key={blockIndex} block={block} />
                  ))}
                </td>
              ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Block({ block }: { block: PreviewBlock }) {
  if (block.type === "table") return <Table table={block} />;
  return <Paragraph paragraph={block} />;
}

/** The sheet itself: fixed width, real margins, continuous by design. */
function Sheet({ doc, sheetRef }: { doc: PreviewDoc; sheetRef?: React.Ref<HTMLDivElement> }) {
  const { page } = doc;
  return (
    <div
      className="pf-paper"
      ref={sheetRef}
      style={{
        width: page.widthPx,
        // The margins live INSIDE the 210mm: border-box makes content width
        // 210 - 25 - 25 = 160mm, which is what every twips value in the payload
        // (table widths, indents) is measured against. With content-box the
        // sheet would render 260mm wide and every line would break late.
        boxSizing: "border-box",
        paddingTop: page.paddingTopPx,
        paddingRight: page.paddingRightPx,
        paddingBottom: page.paddingBottomPx,
        paddingLeft: page.paddingLeftPx,
        // The Normal style the task brief mandates; individual runs override it.
        fontFamily: cssFont("宋体"),
      }}
    >
      {doc.blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </div>
  );
}

export interface DocxPreviewProps {
  doc: PreviewDoc;
  /**
   * "fit" scales the sheet down to the container width (sidebar card);
   * "actual" renders 1:1 with scrolling (enlarged view).
   */
  variant?: "fit" | "actual";
  /**
   * Explicit zoom factor, overriding both variants. Used by the enlarged view,
   * where the operator picks the scale (⌘/Ctrl+wheel, ±, keyboard).
   */
  scale?: number;
  /**
   * Reports the factor actually in use — the fit factor is computed from the
   * container width, so the caller cannot know it otherwise.
   */
  onScaleChange?: (scale: number) => void;
}

/**
 * The sheet, at a scale somebody chose or one that fits.
 *
 * CSS transforms do not affect layout, so the scaled sheet is wrapped in a
 * spacer sized to the scaled content: without it the container scrolls as if
 * the sheet were still full size, and the caller shows a screenful of blank.
 */
export function DocxPreview({
  doc,
  variant = "fit",
  scale,
  onScaleChange,
}: DocxPreviewProps) {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const [sheetSize, setSheetSize] = useState({ width: doc.page.widthPx, height: 0 });
  const [holderWidth, setHolderWidth] = useState(0);

  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return undefined;

    const measure = () => {
      setSheetSize({ width: sheet.offsetWidth, height: sheet.offsetHeight });
    };
    measure();

    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(sheet);
    return () => observer.disconnect();
  }, [doc]);

  useEffect(() => {
    if (variant !== "fit" || scale !== undefined) return undefined;
    const holder = holderRef.current;
    if (!holder) return undefined;

    const measure = () => setHolderWidth(holder.clientWidth);
    measure();

    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(holder);
    return () => observer.disconnect();
  }, [variant, scale]);

  // Fit never scales above 1:1 — a card that blows the sheet up past its real
  // size would lie about how big the text is. Explicit zoom may, within limits.
  const fitScale =
    holderWidth > 0 && sheetSize.width > 0
      ? Math.min(1, holderWidth / sheetSize.width)
      : 1;
  const effectiveScale = scale ?? (variant === "actual" ? 1 : fitScale);

  useEffect(() => {
    onScaleChange?.(effectiveScale);
  }, [effectiveScale, onScaleChange]);

  // 1:1 with no explicit zoom keeps the plain, untransformed path.
  if (variant === "actual" && scale === undefined) {
    return (
      <div className="pf-scroll">
        <Sheet doc={doc} />
      </div>
    );
  }

  return (
    <div className="pf-fit" ref={holderRef}>
      <div
        className="pf-scaler"
        style={{
          width: sheetSize.width * effectiveScale,
          height: sheetSize.height * effectiveScale,
        }}
      >
        <div className="pf-scale" style={{ transform: `scale(${effectiveScale})` }}>
          <Sheet doc={doc} sheetRef={sheetRef} />
        </div>
      </div>
    </div>
  );
}

function formatMm(px: number): string {
  return `${Math.round(px / PX_PER_MM)}mm`;
}

function marginsLabel(doc: PreviewDoc): string {
  const { page } = doc;
  const vertical = page.paddingTopPx === page.paddingBottomPx
    ? formatMm(page.paddingTopPx)
    : `${formatMm(page.paddingTopPx)}/${formatMm(page.paddingBottomPx)}`;
  const horizontal = page.paddingLeftPx === page.paddingRightPx
    ? formatMm(page.paddingLeftPx)
    : `${formatMm(page.paddingLeftPx)}/${formatMm(page.paddingRightPx)}`;
  return `${vertical}/${horizontal}`;
}

export interface PreviewFactsProps {
  doc: PreviewDoc;
  /** Extra classes for layout differences between the card and the overlay. */
  className?: string;
}

/**
 * One line of numbers, one line of caveats — deliberately that short.
 *
 * The numbers answer "is this what I will get" exactly, because they are read
 * out of word/document.xml and Word reports the same content. The single caveat
 * line covers the differences no browser-side preview can remove (pagination,
 * fonts). Everything longer than that is noise in a panel whose job is to show
 * a sheet of paper.
 */
export function PreviewFacts({ doc, className }: PreviewFactsProps): ReactNode {
  const { page, stats } = doc;
  const orientation = page.widthPx >= page.heightPx ? "横向" : "纵向";
  const size = `${formatMm(page.widthPx)}×${formatMm(page.heightPx)}`;

  return (
    <div className={className ? `pf-facts ${className}` : "pf-facts"}>
      <p className="pf-facts-line">
        {size} {orientation} · {marginsLabel(doc)} 页边距 · {stats.paragraphs} 段 ·{" "}
        {stats.tables} 表格 · {stats.answerLineRows} 行答题线 · 字体{" "}
        {stats.fonts.join("/")}
      </p>
      <p className="pf-facts-line pf-facts-dim">
        连续纸面，分页与字体以 Word 为准
      </p>
      {doc.truncated ? (
        <p className="pf-note pf-note-warn">文档很长，预览已截断，请下载查看完整版。</p>
      ) : null}
      {doc.warnings.map((warning) => (
        <p className="pf-note" key={warning}>
          {warning}
        </p>
      ))}
    </div>
  );
}

/**
 * The only thing worth interrupting a pure preview for: notes that say the
 * sheet on screen is not the whole story (truncation, skipped images).
 *
 * Everything else — page size, counts, caveats — can wait until the teacher is
 * back in the panel. Renders nothing in the common case.
 */
export function PreviewNotices({ doc }: { doc: PreviewDoc }): ReactNode {
  if (!doc.truncated && doc.warnings.length === 0) return null;
  return (
    <div className="pf-notices">
      {doc.truncated ? (
        <span className="pf-note pf-note-warn">文档很长，预览已截断</span>
      ) : null}
      {doc.warnings.map((warning) => (
        <span className="pf-note" key={warning}>
          {warning}
        </span>
      ))}
    </div>
  );
}
