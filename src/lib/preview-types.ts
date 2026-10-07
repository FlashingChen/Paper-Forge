/**
 * Wire contract for GET /api/jobs/:id/preview.
 *
 * The payload is produced by scripts/docx_preview.py (see `build_preview`) and
 * painted by src/components/DocxPreview.tsx. The key names are asserted on the
 * Python side by tests/test_docx_preview.py, so renaming a field here without
 * renaming it there fails that test rather than silently blanking the preview.
 */

export type PreviewAlign = "left" | "center" | "right" | "justify";

/**
 * How to read `line`: "auto" means a multiple of single spacing (Word's
 * w:lineRule="auto"), "exact"/"atLeast" mean points (w:lineRule exact/atLeast).
 */
export type PreviewLineRule = "auto" | "exact" | "atLeast";

export interface PreviewRun {
  text: string;
  images?: { src: string; widthPx: number; heightPx: number }[];
  /** Font name exactly as written in the .docx, e.g. "宋体" / "楷体". */
  font: string;
  sizePt: number;
  bold: boolean;
  italic: boolean;
  /** "#rrggbb", or null for automatic colour. */
  color: string | null;
  underline: boolean;
}

export interface PreviewParagraph {
  type: "p";
  align: PreviewAlign;
  indentFirstLinePx: number;
  indentLeftPx: number;
  spaceBeforePx: number;
  spaceAfterPx: number;
  lineRule: PreviewLineRule;
  line: number;
  runs: PreviewRun[];
}

export interface PreviewTableCell {
  colSpan: number;
  rowSpan: number;
  /** True for a w:vMerge continuation cell; the rowSpan above covers it. */
  skip: boolean;
  blocks: PreviewBlock[];
}

export interface PreviewTableRow {
  cells: PreviewTableCell[];
}

export interface PreviewTable {
  type: "table";
  widthsPx: number[];
  rows: PreviewTableRow[];
}

export type PreviewBlock = PreviewParagraph | PreviewTable;

export interface PreviewPage {
  widthPx: number;
  heightPx: number;
  paddingTopPx: number;
  paddingRightPx: number;
  paddingBottomPx: number;
  paddingLeftPx: number;
}

/**
 * Counts read straight out of word/document.xml.
 *
 * These are the numbers a teacher can trust: unlike the painted sheet, they do
 * not depend on the browser, the fonts installed locally, or where Word
 * decides to break pages. `fonts` doubles as the answer to "will this look the
 * same on my computer" — it lists what the document actually asks for.
 */
export interface PreviewStats {
  paragraphs: number;
  tables: number;
  tableCells: number;
  answerLineRows: number;
  answerChars: number;
  textChars: number;
  fonts: string[];
}

export interface PreviewDoc {
  ok: true;
  page: PreviewPage;
  stats: PreviewStats;
  blocks: PreviewBlock[];
  /** True when the document was too large to preview in full. */
  truncated: boolean;
  /** Human-readable notes: skipped images, missing fonts, truncation. */
  warnings: string[];
}

export interface PreviewFailure {
  ok: false;
  error: string;
}

export type PreviewResponse = PreviewDoc | PreviewFailure;
