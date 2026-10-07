#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PaperForge preview extractor for generated .docx files.

Turns out/result.docx into a JSON tree the web UI can paint as an A4 sheet,
without any rendering library: it walks word/document.xml directly, the same
way scripts/verify.py does. Standard library only (zipfile + ElementTree), so
the preview keeps working even if the Python venv is broken.

Usage:
    python3 scripts/docx_preview.py path/to/result.docx

Output (stdout), exit status 0:

    {
      "ok": true,
      "page":  { "widthPx": 793.7, "heightPx": 1122.5,
                 "paddingTopPx": 75.6, "paddingRightPx": 94.5,
                 "paddingBottomPx": 75.6, "paddingLeftPx": 94.5 },
      "stats": { "paragraphs": 18, "tables": 3, "tableCells": 14,
                 "answerLineRows": 42, "answerChars": 1520,
                 "textChars": 3120, "fonts": ["宋体", "楷体"] },
      "blocks": [ ... ],
      "truncated": false,
      "warnings": [ "..." ]
    }

On failure, exit status 2 and stdout {"ok": false, "error": "..."}. The
traceback goes to stderr.

The JSON key names are a contract with src/lib/preview-types.ts. Renaming a
key here without renaming it there breaks the preview — tests/test_docx_preview.py
asserts the key names on purpose so that mistake fails loudly.

Fidelity contract (why this is "close to Word", not "Word"):

  * Geometry and fonts come from the document, but LAYOUT does not: this is a
    continuous sheet. Word decides where pages break; we do not guess.
  * Defaults match agent/snippets/docx_helpers.py new_doc(), i.e. the Normal
    style the task brief mandates: 宋体, 10.5pt, no paragraph spacing, single
    line spacing. A run with no explicit font/size is counted and reported in
    `warnings`, because that is exactly the case where a preview can diverge.
"""

from __future__ import annotations

import json
import base64
import math
import posixpath
import sys
import traceback
import zipfile
from typing import Any, Optional
from xml.etree import ElementTree as ET

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

DOCUMENT_PART = "word/document.xml"

# 96 CSS pixels per inch; Word measures in twips (1/1440 inch).
TWIPS_PER_PX = 15.0
# CSS pt and Word pt are both 1/72 inch, so font sizes pass through untouched.
PX_PER_PT = 96.0 / 72.0

# A4 portrait plus the project's fixed margins, in twips. Used only as a
# fallback when the document does not state its own page setup.
A4_WIDTH_TWIPS = 11906
A4_HEIGHT_TWIPS = 16838
MARGIN_TB_TWIPS = 1134
MARGIN_LR_TWIPS = 1417

# Defaults from the Normal style that docx_helpers.new_doc() installs.
DEFAULT_FONT = "宋体"
DEFAULT_SIZE_PT = 10.5

# Fullwidth low line: the answer-area character.
ANSWER_CHAR = "\uFF3F"

# Payload guards. A pathological document must not blow up the browser.
MAX_BLOCKS = 4000
MAX_TEXT_CHARS = 1_500_000
MAX_TABLE_DEPTH = 3

# w:jc value -> CSS text-align.
ALIGNMENTS = {
    "left": "left",
    "start": "left",
    "center": "center",
    "right": "right",
    "end": "right",
    "both": "justify",
    "distribute": "justify",
}

def qn(local: str) -> str:
    """Expand a local w: tag name into Clark notation."""
    return f"{{{W}}}{local}"


# Block-level wrappers that are transparent: their paragraphs are ordinary
# paragraphs that happen to be nested (content controls, tracked-change
# containers). Recursing keeps their text, which the "same text as the .docx"
# promise depends on.
BLOCK_CONTAINER_TAGS = frozenset(
    qn(name)
    for name in (
        "sdt",
        "sdtContent",
        "customXml",
        "ins",
        "del",
        "moveFrom",
        "moveTo",
        "smartTag",
    )
)


# Elements that wrap runs without producing text of their own.
CONTAINER_TAGS = frozenset(
    qn(name)
    for name in (
        "hyperlink",
        "smartTag",
        "ins",
        "del",
        "moveFrom",
        "moveTo",
        "sdt",
        "sdtContent",
        "fldSimple",
        "dir",
        "bdo",
    )
)

# Elements inside w:p / w:tc that carry no renderable content.
IGNORED_TAGS = frozenset(
    qn(name)
    for name in (
        "pPr",
        "rPr",
        "tblPr",
        "tblPrEx",
        "trPr",
        "tcPr",
        "tblGrid",
        "sectPr",
        "bookmarkStart",
        "bookmarkEnd",
        "commentRangeStart",
        "commentRangeEnd",
        "commentReference",
        "proofErr",
        "permStart",
        "permEnd",
        "lastRenderedPageBreak",
    )
)


class PreviewError(Exception):
    """A document we cannot turn into a preview, with a user-safe message."""


# --------------------------------------------------------------- utilities ---


def _num(element: Optional[ET.Element], name: str) -> Optional[float]:
    """Read a numeric attribute; None when absent or unparsable."""
    if element is None:
        return None
    raw = element.get(qn(name))
    if raw is None:
        return None
    raw = raw.strip()
    if raw == "":
        return None
    try:
        return int(raw)
    except ValueError:
        pass
    try:
        return float(raw)
    except ValueError:
        return None


def _px(twips: Optional[float]) -> float:
    """Twips -> CSS pixels, rounded to 2 decimals."""
    if twips is None:
        return 0.0
    return round(float(twips) / TWIPS_PER_PX, 2)


def _on_off(element: Optional[ET.Element]) -> bool:
    """OOXML toggle: present with no val (or a truthy val) means on."""
    if element is None:
        return False
    raw = element.get(qn("val"))
    if raw is None:
        return True
    return raw.strip().lower() not in ("0", "false", "off")


def _is_underline(element: Optional[ET.Element]) -> bool:
    if element is None:
        return False
    raw = element.get(qn("val"))
    if raw is None:
        return True
    return raw.strip().lower() != "none"


def _load_document_xml(path: str) -> ET.Element:
    """Extract and parse word/document.xml, mapping failures to PreviewError."""
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            if DOCUMENT_PART not in names:
                raise PreviewError("文件里没有 word/document.xml，可能不是 Word 文档。")
            raw = archive.read(DOCUMENT_PART)
    except zipfile.BadZipFile:
        raise PreviewError("文件不是合法的 docx（zip 打开失败）。")
    except FileNotFoundError:
        raise PreviewError("找不到文档文件。")
    except OSError as exc:
        raise PreviewError(f"读取文档失败：{exc.strerror or exc}")

    try:
        return ET.fromstring(raw)
    except ET.ParseError as exc:
        raise PreviewError(f"document.xml 解析失败：{exc}")


# ----------------------------------------------------------------- builder ---


class Builder:
    """Accumulates blocks, counts and warnings for one document."""

    def __init__(self, page: dict[str, float], images=None) -> None:
        self.images = images or {}
        self.rendered_images = 0
        self.image_payload_bytes = 0
        self.page = page
        self.usable_px = max(
            1.0,
            page["widthPx"] - page["paddingLeftPx"] - page["paddingRightPx"],
        )

        self.warnings: list[str] = []
        self._warned: set[str] = set()
        self.truncated = False

        # Structure counters (top level only, so "N 段" means what a reader
        # counts on the sheet, not including table-cell paragraphs).
        self.paragraphs = 0
        self.tables = 0
        self._blocks = 0

        # Text counters.
        self.table_cells = 0
        self.answer_chars = 0
        self.answer_rows = 0
        self.text_chars = 0
        self.fonts: set[str] = set()

        # Fidelity signals: where the preview had to fall back to a default.
        self.fontless_runs = 0
        self.sizeless_runs = 0
        self.page_breaks = 0
        self.tabs = 0

    # -- warnings ---------------------------------------------------------

    def warn(self, message: str) -> None:
        if message not in self._warned:
            self._warned.add(message)
            self.warnings.append(message)

    # -- budget -----------------------------------------------------------

    def take_block(self) -> bool:
        """Reserve one block slot; False once the payload is capped."""
        if self._blocks >= MAX_BLOCKS or self.text_chars >= MAX_TEXT_CHARS:
            if not self.truncated:
                self.truncated = True
                self.warn("文档很长，预览已截断，请下载查看完整版。")
            return False
        self._blocks += 1
        return True

    # -- runs -------------------------------------------------------------

    def _run_props(self, rpr: Optional[ET.Element]) -> dict[str, Any]:
        font = DEFAULT_FONT
        size_pt = DEFAULT_SIZE_PT
        bold = False
        italic = False
        underline = False
        color: Optional[str] = None

        explicit_font = False
        explicit_size = False

        if rpr is not None:
            rfonts = rpr.find(qn("rFonts"))
            if rfonts is not None:
                # eastAsia first: Chinese text is what matters here, and the
                # project mandates all four attributes be written explicitly.
                for key in ("eastAsia", "ascii", "hAnsi", "cs"):
                    value = rfonts.get(qn(key))
                    if value and value.strip():
                        font = value.strip()
                        explicit_font = True
                        break

            size_el = rpr.find(qn("sz"))
            if size_el is not None:
                half_points = _num(size_el, "val")
                if half_points and half_points > 0:
                    size_pt = float(half_points) / 2.0
                    explicit_size = True

            bold = _on_off(rpr.find(qn("b")))
            italic = _on_off(rpr.find(qn("i")))
            underline = _is_underline(rpr.find(qn("u")))

            color_el = rpr.find(qn("color"))
            if color_el is not None:
                value = (color_el.get(qn("val")) or "").strip()
                if len(value) == 6 and value.lower() != "auto":
                    color = "#" + value.lower()

        if not explicit_font:
            self.fontless_runs += 1
        if not explicit_size:
            self.sizeless_runs += 1

        self.fonts.add(font)

        return {
            "font": font,
            "sizePt": size_pt,
            "bold": bold,
            "italic": italic,
            "color": color,
            "underline": underline,
        }

    def _run_text(self, run: ET.Element) -> str:
        parts: list[str] = []
        for child in run:
            tag = child.tag
            if tag == qn("t"):
                parts.append(child.text or "")
            elif tag == qn("br"):
                if (child.get(qn("type")) or "").lower() == "page":
                    self.page_breaks += 1
                parts.append("\n")
            elif tag == qn("tab"):
                self.tabs += 1
                parts.append("\t")
        return "".join(parts)

    def build_run(self, run: ET.Element) -> Optional[dict[str, Any]]:
        text = self._run_text(run)
        pictures = []
        for drawing in run.iter(qn("drawing")):
            ns = "http://schemas.openxmlformats.org/drawingml/2006/"
            blip = drawing.find(".//{" + ns + "main}blip")
            extent = drawing.find(".//{" + ns + "wordprocessingDrawing}extent")
            rid = blip.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed") if blip is not None else None
            image = self.images.get(rid)
            if image is None or extent is None:
                continue
            try:
                width, height = float(extent.get("cx", "0"))/9525, float(extent.get("cy", "0"))/9525
            except ValueError:
                continue
            if not all(math.isfinite(v) and 0 < v <= 10000 for v in (width, height)):
                continue
            if self.image_payload_bytes + len(image) > 3_000_000:
                continue
            pictures.append({"src": image, "widthPx": round(width, 2), "heightPx": round(height, 2)})
            self.image_payload_bytes += len(image)
            self.rendered_images += 1
        if text == "" and not pictures:
            return None

        props = self._run_props(run.find(qn("rPr")))
        self.answer_chars += text.count(ANSWER_CHAR)
        self.text_chars += len(text) - text.count(ANSWER_CHAR)

        merged = {"text": text}
        merged.update(props)
        if pictures:
            merged["images"] = pictures
        return merged

    # -- paragraphs -------------------------------------------------------

    def _paragraph_props(
        self, ppr: Optional[ET.Element], base_size_pt: float
    ) -> dict[str, Any]:
        align = "left"
        indent_first = 0.0
        indent_left = 0.0
        space_before = 0.0
        space_after = 0.0
        line_rule = "auto"
        line = 1.0

        if ppr is None:
            return {
                "align": align,
                "indentFirstLinePx": indent_first,
                "indentLeftPx": indent_left,
                "spaceBeforePx": space_before,
                "spaceAfterPx": space_after,
                "lineRule": line_rule,
                "line": line,
            }

        jc = ppr.find(qn("jc"))
        if jc is not None:
            align = ALIGNMENTS.get((jc.get(qn("val")) or "").strip().lower(), "left")

        ind = ppr.find(qn("ind"))
        if ind is not None:
            # Word writes character-based indents for Chinese documents; both
            # forms have to be honoured or first-line indents go missing.
            first_chars = _num(ind, "firstLineChars")
            if first_chars:
                indent_first = round(
                    (float(first_chars) / 100.0) * base_size_pt * PX_PER_PT, 2
                )
            else:
                indent_first = _px(_num(ind, "firstLine"))
            left_twips = _num(ind, "left")
            if left_twips is None:
                left_twips = _num(ind, "start")
            indent_left = _px(left_twips)

        spacing = ppr.find(qn("spacing"))
        if spacing is not None:
            space_before = _px(_num(spacing, "before"))
            space_after = _px(_num(spacing, "after"))
            raw_line = _num(spacing, "line")
            rule = (spacing.get(qn("lineRule")) or "auto").strip().lower()
            if raw_line:
                if rule == "auto":
                    line_rule = "auto"
                    line = round(float(raw_line) / 240.0, 3)
                else:
                    line_rule = "exact" if rule == "exact" else "atLeast"
                    line = round(float(raw_line) / 20.0, 2)

        return {
            "align": align,
            "indentFirstLinePx": indent_first,
            "indentLeftPx": indent_left,
            "spaceBeforePx": space_before,
            "spaceAfterPx": space_after,
            "lineRule": line_rule,
            "line": line,
        }

    def _paragraph_runs(self, paragraph: ET.Element) -> list[dict[str, Any]]:
        runs: list[dict[str, Any]] = []
        for child in paragraph:
            tag = child.tag
            if tag == qn("r"):
                candidates = [child]
            elif tag in CONTAINER_TAGS:
                candidates = list(child.iter(qn("r")))
            else:
                continue

            for run_el in candidates:
                built = self.build_run(run_el)
                if built is None:
                    continue
                # Merge neighbours with identical formatting: fewer nodes,
                # same text.
                if runs and _same_format(runs[-1], built):
                    runs[-1]["text"] += built["text"]
                else:
                    runs.append(built)
        return runs

    def build_paragraph(self, paragraph: ET.Element) -> dict[str, Any]:
        runs = self._paragraph_runs(paragraph)
        base_size = runs[0]["sizePt"] if runs else DEFAULT_SIZE_PT
        props = self._paragraph_props(paragraph.find(qn("pPr")), base_size)
        text = "".join(run["text"] for run in runs)
        if ANSWER_CHAR in text:
            self.answer_rows += 1

        block: dict[str, Any] = {"type": "p"}
        block.update(props)
        block["runs"] = runs
        return block

    # -- tables -----------------------------------------------------------

    def build_table(self, table: ET.Element, depth: int) -> dict[str, Any]:
        rows_raw: list[list[dict[str, Any]]] = []

        for tr in table.findall(qn("tr")):
            cells: list[dict[str, Any]] = []
            for tc in tr.findall(qn("tc")):
                tcpr = tc.find(qn("tcPr"))
                col_span = 1
                v_merge: Optional[str] = None

                if tcpr is not None:
                    span_el = tcpr.find(qn("gridSpan"))
                    if span_el is not None:
                        span = _num(span_el, "val")
                        if span and span > 0:
                            col_span = int(span)
                    merge_el = tcpr.find(qn("vMerge"))
                    if merge_el is not None:
                        value = (merge_el.get(qn("val")) or "continue").strip().lower()
                        v_merge = "restart" if value == "restart" else "continue"

                cells.append(
                    {
                        "colSpan": col_span,
                        "vMerge": v_merge,
                        "rowSpan": 1,
                        "skip": False,
                        "blocks": self.build_blocks(tc, depth + 1),
                    }
                )

            if cells:
                rows_raw.append(cells)

        column_count = max(
            (sum(cell["colSpan"] for cell in row) for row in rows_raw), default=0
        )

        widths = self._table_widths(table, column_count)

        # Resolve vertical merges: a "restart" cell owns the rowSpan, every
        # following "continue" cell in the same column is skipped by the UI.
        lookup: dict[tuple[int, int], dict[str, Any]] = {}
        for row_index, row in enumerate(rows_raw):
            column = 0
            for cell in row:
                for offset in range(cell["colSpan"]):
                    lookup.setdefault((row_index, column + offset), cell)
                column += cell["colSpan"]

        for row_index, row in enumerate(rows_raw):
            column = 0
            for cell in row:
                if cell["vMerge"] == "restart":
                    span_rows = 1
                    probe = row_index + 1
                    while True:
                        below = lookup.get((probe, column))
                        if (
                            below is None
                            or below["vMerge"] != "continue"
                            or below["colSpan"] != cell["colSpan"]
                        ):
                            break
                        below["skip"] = True
                        span_rows += 1
                        probe += 1
                    cell["rowSpan"] = span_rows
                column += cell["colSpan"]

        rows_payload: list[dict[str, Any]] = []
        for row in rows_raw:
            cells_payload: list[dict[str, Any]] = []
            for cell in row:
                if cell["skip"]:
                    # A continuation cell is covered by the rowSpan above it and
                    # is never rendered, so its content is dropped from the
                    # payload rather than shipped for nothing.
                    cells_payload.append(
                        {
                            "colSpan": cell["colSpan"],
                            "rowSpan": 1,
                            "skip": True,
                            "blocks": [],
                        }
                    )
                    continue
                self.table_cells += 1
                cells_payload.append(
                    {
                        "colSpan": cell["colSpan"],
                        "rowSpan": cell["rowSpan"],
                        "skip": False,
                        "blocks": cell["blocks"],
                    }
                )
            rows_payload.append({"cells": cells_payload})

        return {"type": "table", "widthsPx": widths, "rows": rows_payload}

    def _table_widths(self, table: ET.Element, column_count: int) -> list[float]:
        widths: list[float] = []
        grid = table.find(qn("tblGrid"))
        if grid is not None:
            for grid_col in grid.findall(qn("gridCol")):
                raw = _num(grid_col, "w")
                if raw and raw > 0:
                    widths.append(_px(raw))

        if column_count <= 0:
            return widths
        if len(widths) == column_count:
            return widths
        if not widths:
            # No grid: give every column an equal share of the text column.
            share = round(self.usable_px / column_count, 2)
            return [share] * column_count
        # Mismatched grid: pad or trim so the UI can always lay out a row.
        if len(widths) < column_count:
            widths.extend([widths[-1]] * (column_count - len(widths)))
        return widths[:column_count]

    # -- containers -------------------------------------------------------

    def build_blocks(self, container: ET.Element, depth: int) -> list[dict[str, Any]]:
        blocks: list[dict[str, Any]] = []
        for child in container:
            tag = child.tag
            if tag == qn("p"):
                if not self.take_block():
                    break
                if depth == 0:
                    self.paragraphs += 1
                blocks.append(self.build_paragraph(child))
            elif tag == qn("tbl"):
                if depth >= MAX_TABLE_DEPTH:
                    self.warn("文档里嵌套表格太深，内层表格没有预览。")
                    continue
                if not self.take_block():
                    break
                if depth == 0:
                    self.tables += 1
                blocks.append(self.build_table(child, depth))
            elif tag in BLOCK_CONTAINER_TAGS:
                # Transparent wrapper: keep going in place so nested paragraphs
                # stay in document order and are not silently dropped.
                blocks.extend(self.build_blocks(child, depth))
            elif tag in IGNORED_TAGS:
                continue
            elif list(child.iter(qn("t"))):
                # An element we do not understand that still carries text: say
                # so rather than quietly losing it, which would break the one
                # promise the preview makes about its content.
                self.warn("文档里有预览认不出的结构，可能显示不全。")
            # Anything else inside a body/cell is not renderable content.
        return blocks

    # -- results ----------------------------------------------------------

    def finalize(self, root: ET.Element) -> None:
        """Document-wide feature scan, then turn counters into warnings."""
        images = len(list(root.iter(qn("drawing")))) + len(list(root.iter(qn("pict"))))
        skipped_images = images - self.rendered_images
        if skipped_images:
            self.warn(f"有 {skipped_images} 张图片因格式或大小限制未显示，请下载查看。")

        if list(root.iter(qn("pBdr"))) or list(root.iter(qn("shd"))):
            self.warn("文档里有边框或底纹设置，预览不显示。")

        if self.page_breaks:
            self.warn(
                f"文档里有 {self.page_breaks} 处硬分页符，"
                "预览按连续纸面显示，实际分页以 Word 为准。"
            )
        if self.tabs:
            self.warn(f"文档里用了 {self.tabs} 个 Tab，预览按空白渲染。")
        if self.fontless_runs:
            self.warn(
                f"{self.fontless_runs} 处文字没有显式指定字体，"
                f"预览按{DEFAULT_FONT}显示，Word 里可能不同。"
            )
        if self.sizeless_runs:
            self.warn(
                f"{self.sizeless_runs} 处文字没有显式指定字号，"
                f"预览按 {DEFAULT_SIZE_PT:g}pt 显示。"
            )

    def stats(self) -> dict[str, Any]:
        return {
            "paragraphs": self.paragraphs,
            "tables": self.tables,
            "tableCells": self.table_cells,
            "answerLineRows": self.answer_rows,
            "answerChars": self.answer_chars,
            "textChars": self.text_chars,
            "fonts": sorted(self.fonts) or [DEFAULT_FONT],
        }


def _same_format(left: dict[str, Any], right: dict[str, Any]) -> bool:
    if left.get("images") or right.get("images"):
        return False
    for key in ("font", "sizePt", "bold", "italic", "color", "underline"):
        if left.get(key) != right.get(key):
            return False
    return True


# ------------------------------------------------------------- page setup ---


def build_page(root: ET.Element) -> dict[str, float]:
    """Page size and margins in CSS pixels, falling back to A4 + 20/25mm."""
    sections = list(root.iter(qn("sectPr")))
    section = sections[-1] if sections else None

    width_twips: Optional[float] = A4_WIDTH_TWIPS
    height_twips: Optional[float] = A4_HEIGHT_TWIPS
    top = float(MARGIN_TB_TWIPS)
    bottom = float(MARGIN_TB_TWIPS)
    left = float(MARGIN_LR_TWIPS)
    right = float(MARGIN_LR_TWIPS)

    if section is not None:
        page_size = section.find(qn("pgSz"))
        if page_size is not None:
            value = _num(page_size, "w")
            if value:
                width_twips = value
            value = _num(page_size, "h")
            if value:
                height_twips = value
            orient = (page_size.get(qn("orient")) or "").strip().lower()
            if (
                orient == "landscape"
                and width_twips is not None
                and height_twips is not None
                and height_twips > width_twips
            ):
                width_twips, height_twips = height_twips, width_twips

        margins = section.find(qn("pgMar"))
        if margins is not None:
            for name, fallback in (
                ("top", top),
                ("bottom", bottom),
                ("left", left),
                ("right", right),
            ):
                value = _num(margins, name)
                if value is not None:
                    value = max(0.0, value)
                    if name == "top":
                        top = value
                    elif name == "bottom":
                        bottom = value
                    elif name == "left":
                        left = value
                    else:
                        right = value

    return {
        "widthPx": _px(width_twips),
        "heightPx": _px(height_twips),
        "paddingTopPx": _px(top),
        "paddingRightPx": _px(right),
        "paddingBottomPx": _px(bottom),
        "paddingLeftPx": _px(left),
    }


def _load_images(path: str) -> dict[str, str]:
    """Read only bounded embedded JPEG/PNG parts; never fetch external targets."""
    result = {}
    total = 0
    with zipfile.ZipFile(path) as archive:
        rels_part = "word/_rels/document.xml.rels"
        if rels_part not in archive.namelist() or archive.getinfo(rels_part).file_size > 256_000:
            return result
        try:
            rels = ET.fromstring(archive.read(rels_part))
        except ET.ParseError:
            return result
        for rel in rels:
            if rel.get("TargetMode") == "External" or not rel.get("Type", "").endswith("/image"):
                continue
            target = posixpath.normpath(posixpath.join("word", rel.get("Target", "")))
            if not target.startswith("word/media/"):
                continue
            try:
                info = archive.getinfo(target)
            except KeyError:
                continue
            if info.file_size > 1_000_000 or total + info.file_size > 2_000_000:
                continue
            raw = archive.read(info)
            mime = "image/png" if raw.startswith(b"\x89PNG\r\n\x1a\n") else "image/jpeg" if raw.startswith(b"\xff\xd8\xff") else None
            if mime:
                result[rel.get("Id")] = f"data:{mime};base64," + base64.b64encode(raw).decode("ascii")
                total += len(raw)
    return result


# ------------------------------------------------------------------ entry ---


def build_preview(path: str) -> dict[str, Any]:
    """Parse `path` into the preview payload. Raises PreviewError."""
    root = _load_document_xml(path)
    body = root.find(qn("body"))
    if body is None:
        raise PreviewError("文档缺少 w:body，无法解析。")

    page = build_page(root)
    builder = Builder(page, _load_images(path))
    blocks = builder.build_blocks(body, 0)
    builder.finalize(root)

    return {
        "ok": True,
        "page": page,
        "stats": builder.stats(),
        "blocks": blocks,
        "truncated": builder.truncated,
        "warnings": builder.warnings,
    }


def _fail(message: str) -> int:
    json.dump({"ok": False, "error": message}, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 2


def main(argv: list[str]) -> int:
    # The payload is UTF-8; do not depend on the ambient locale being UTF-8
    # (the container may run with LANG=C, where stdout would be ASCII).
    reconfigure = getattr(sys.stdout, "reconfigure", None)
    if reconfigure is not None:
        try:
            reconfigure(encoding="utf-8")
        except (ValueError, OSError):
            pass

    if len(argv) != 2:
        print("usage: docx_preview.py <result.docx>", file=sys.stderr)
        return _fail("用法：docx_preview.py <result.docx>")

    try:
        payload = build_preview(argv[1])
    except PreviewError as exc:
        return _fail(str(exc))
    except Exception:  # noqa: BLE001 - never leak a traceback to the client
        traceback.print_exc()
        return _fail("解析文档时发生意外错误。")

    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
