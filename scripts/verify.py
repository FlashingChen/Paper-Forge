#!/usr/bin/env python3
"""
PaperForge structural checker for generated .docx files.

It unzips the document and inspects word/document.xml directly, because
python-docx does not expose run-level font inheritance or the emphasis /
underline attributes that matter here.

Usage:
    python3 scripts/verify.py path/to/result.docx

Exit status:
    0  no ERRORs found (WARNings may still be present)
    1  at least one ERROR found, or the file could not be inspected

Document validation rules:
    ERROR  page is not A4 portrait, or margins are outside tolerance
    ERROR  a run exists with no explicit w:eastAsia font
    ERROR  a run exists whose w:eastAsia font is not an explicitly-set value
    ERROR  page breaks (hard <w:br w:type="page"/> or w:pageBreakBefore)
    ERROR  paragraph shading / decorative borders
    ERROR  a table cell count mismatch (row with a different number of cells)
    WARN   2 or more consecutive empty paragraphs
    WARN   answer lines whose total line count looks too small for a table row
"""

from __future__ import annotations

import re
import sys
import zipfile
from collections import Counter
from dataclasses import dataclass, field
from xml.etree import ElementTree as ET

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W}

# A4 portrait in twips (1 twip = 1/20 pt; 210mm x 297mm).
A4_WIDTH_TWIPS = 11906
A4_HEIGHT_TWIPS = 16838
A4_TOLERANCE_TWIPS = 20

# 20mm and 25mm in twips; tolerances are small but nonzero because a converter
# may round to the nearest whole twip.
MM_TO_TWIPS = 20 * 28.3465 / 20  # 1mm = 56.6929 twips
TARGET_TOP_BOTTOM = round(20 * 56.6929)  # 1134
TARGET_LEFT_RIGHT = round(25 * 56.6929)  # 1417
MARGIN_TOLERANCE = 12

# Fullwidth low line, used for answer areas.
ANSWER_CHAR = "\uFF3F"

# Minimum answer lines for a given point value, mirroring the task brief.
MIN_LINES_PER_POINT = 1

# Path key inside the zip.
DOCUMENT_PART = "word/document.xml"


@dataclass
class Finding:
    level: str  # "ERROR" | "WARN" | "INFO"
    message: str


@dataclass
class Report:
    findings: list[Finding] = field(default_factory=list)

    def error(self, message: str) -> None:
        self.findings.append(Finding("ERROR", message))

    def warn(self, message: str) -> None:
        self.findings.append(Finding("WARN", message))

    def info(self, message: str) -> None:
        self.findings.append(Finding("INFO", message))

    @property
    def error_count(self) -> int:
        return sum(1 for f in self.findings if f.level == "ERROR")

    @property
    def warn_count(self) -> int:
        return sum(1 for f in self.findings if f.level == "WARN")


def qn(tag: str) -> str:
    """Expand a local w: tag name into a Clark-notation name."""
    return f"{{{W}}}{tag}"


def load_document_xml(path: str) -> ET.Element:
    """Extract and parse word/document.xml from a .docx (a zip archive)."""
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        if DOCUMENT_PART not in names:
            raise ValueError(
                f"{DOCUMENT_PART} is missing; found: {', '.join(sorted(names)[:12])}"
            )
        raw = zf.read(DOCUMENT_PART)
    return ET.fromstring(raw)


def paragraph_text(p: ET.Element) -> str:
    """Concatenated text of a paragraph, including runs inside hyperlinks."""
    return "".join(t.text or "" for t in p.iter(qn("t")))


# --------------------------------------------------------------- sections ---


def check_sections(root: ET.Element, report: Report) -> None:
    """Verify A4 portrait and the required margins on every section."""
    sections = list(root.iter(qn("sectPr")))
    if not sections:
        report.error("no <w:sectPr> found: cannot determine page size or margins")
        return

    print(f"Sections                 : {len(sections)}")

    for index, sect in enumerate(sections, start=1):
        pg_sz = sect.find(qn("pgSz"))
        pg_mar = sect.find(qn("pgMar"))
        label = f"section {index}"

        if pg_sz is None:
            report.error(f"{label}: no <w:pgSz> (page size undefined)")
        else:
            width = int(pg_sz.get(qn("w")) or 0)
            height = int(pg_sz.get(qn("h")) or 0)
            orient = pg_sz.get(qn("orient")) or "portrait"
            print(
                f"  {label} page size        : {width} x {height} twips "
                f"({width / 56.6929:.1f}mm x {height / 56.6929:.1f}mm), orient={orient}"
            )
            if orient != "portrait":
                report.error(f"{label}: orientation is {orient!r}, expected portrait")
            if abs(width - A4_WIDTH_TWIPS) > A4_TOLERANCE_TWIPS or abs(
                height - A4_HEIGHT_TWIPS
            ) > A4_TOLERANCE_TWIPS:
                report.error(
                    f"{label}: page size {width}x{height} twips is not A4 portrait "
                    f"({A4_WIDTH_TWIPS}x{A4_HEIGHT_TWIPS})"
                )

        if pg_mar is None:
            report.error(f"{label}: no <w:pgMar> (margins undefined)")
            continue

        top = int(pg_mar.get(qn("top")) or 0)
        bottom = int(pg_mar.get(qn("bottom")) or 0)
        left = int(pg_mar.get(qn("left")) or 0)
        right = int(pg_mar.get(qn("right")) or 0)
        print(
            f"  {label} margins          : top={top} bottom={bottom} "
            f"left={left} right={right} twips "
            f"(top/bottom {top / 56.6929:.1f}mm, left/right {left / 56.6929:.1f}mm)"
        )

        for name, value, target in (
            ("top", top, TARGET_TOP_BOTTOM),
            ("bottom", bottom, TARGET_TOP_BOTTOM),
            ("left", left, TARGET_LEFT_RIGHT),
            ("right", right, TARGET_LEFT_RIGHT),
        ):
            if abs(value - target) > MARGIN_TOLERANCE:
                report.error(
                    f"{label}: {name} margin is {value} twips "
                    f"({value / 56.6929:.1f}mm), expected {target} "
                    f"({target / 56.6929:.1f}mm)"
                )


# ------------------------------------------------------------- paragraphs ---


def iter_body_blocks(root: ET.Element):
    """Yield direct children of <w:body> in document order."""
    body = root.find(qn("body"))
    if body is None:
        return
    for child in body:
        yield child


def check_paragraphs(root: ET.Element, report: Report) -> None:
    """Count paragraphs, flag consecutive blanks, count page breaks."""
    body = root.find(qn("body"))
    if body is None:
        report.error("no <w:body> element found")
        return

    # Only top-level paragraphs count for the blank-run warning: paragraphs
    # inside table cells are structural and legitimately empty.
    top_paragraphs = [c for c in body if c.tag == qn("p")]
    print(f"Top-level paragraphs     : {len(top_paragraphs)}")

    blank_run = 0
    worst_blank_run = 0
    blank_run_at = 0
    for index, p in enumerate(top_paragraphs, start=1):
        if paragraph_text(p).strip() == "":
            blank_run += 1
            if blank_run == 2:
                blank_run_at = index - 1
        else:
            if blank_run >= 2:
                report.warn(
                    f"{blank_run} consecutive empty paragraphs ending at paragraph "
                    f"{index - 1} (starting at {blank_run_at})"
                )
            worst_blank_run = max(worst_blank_run, blank_run)
            blank_run = 0
    if blank_run >= 2:
        report.warn(
            f"{blank_run} consecutive empty paragraphs at the end of the document "
            f"(starting at paragraph {blank_run_at})"
        )
    worst_blank_run = max(worst_blank_run, blank_run)
    print(f"Longest blank paragraph run: {worst_blank_run}")

    # Page breaks: hard breaks and paragraph-level break-before.
    hard_breaks = sum(
        1
        for br in root.iter(qn("br"))
        if (br.get(qn("type")) or "").lower() == "page"
    )
    break_before = sum(
        1 for p in root.iter(qn("p")) if p.find(f"{qn('pPr')}/{qn('pageBreakBefore')}") is not None
    )
    print(f"Page breaks (informational): hard={hard_breaks} pageBreakBefore={break_before}")
    if hard_breaks:
        report.error(
            f"found {hard_breaks} hard page break(s) "
            "(<w:br w:type=\"page\"/>); the spec forbids page breaks"
        )
    if break_before:
        report.error(
            f"found {break_before} paragraph(s) with pageBreakBefore; "
            "the spec forbids page breaks"
        )

    # 答题线只能用 U+FF3F 字符；段落边框不能再充当答题线。
    shaded = sum(1 for p in root.iter(qn("p"))
                 if p.find(f"{qn('pPr')}/{qn('shd')}") is not None)
    bordered = sum(1 for p in root.iter(qn("p"))
                   if p.find(f"{qn('pPr')}/{qn('pBdr')}") is not None)
    print(f"Paragraphs with shading   : {shaded}")
    print(f"Paragraphs with borders   : {bordered}")
    if shaded:
        report.error(f"found {shaded} paragraph(s) with shading (w:shd); not allowed")
    if bordered:
        report.error(
            f"found {bordered} paragraph(s) with w:pBdr borders; "
            "answer lines must use fullwidth underscore characters U+FF3F (＿), "
            "not paragraph borders"
        )


# ------------------------------------------------------------------- runs ---


def check_runs(root: ET.Element, report: Report) -> None:
    """Check that every run sets an explicit eastAsia font."""
    runs = list(root.iter(qn("r")))
    print(f"Runs                     : {len(runs)}")

    east_asia_fonts: Counter[str] = Counter()
    ascii_fonts: Counter[str] = Counter()
    no_font_at_all = 0
    no_east_asia = 0
    em_count = 0
    underline_single = 0
    underline_wave = 0

    for r in runs:
        rPr = r.find(qn("rPr"))
        rFonts = rPr.find(qn("rFonts")) if rPr is not None else None

        if rFonts is None:
            no_font_at_all += 1
        else:
            for attr, counter in (("ascii", ascii_fonts), ("hAnsi", ascii_fonts)):
                value = rFonts.get(qn(attr))
                if value:
                    counter[value] += 1

        east = rFonts.get(qn("eastAsia")) if rFonts is not None else None
        if east:
            east_asia_fonts[east] += 1
        else:
            no_east_asia += 1

        # Emphasis marks (w:em) and underline styles.
        if rPr is not None:
            if rPr.find(qn("em")) is not None:
                em_count += 1
            u = rPr.find(qn("u"))
            if u is not None:
                val = (u.get(qn("val")) or "single").lower()
                if val == "single":
                    underline_single += 1
                elif val == "wave":
                    underline_wave += 1

    print(f"Runs with no rFonts at all: {no_font_at_all}")
    print(f"Runs with no w:eastAsia  : {no_east_asia}")
    if east_asia_fonts:
        for font, count in east_asia_fonts.most_common():
            print(f"  eastAsia font          : {font!r} on {count} run(s)")
    else:
        print("  eastAsia font          : (none)")
    if ascii_fonts:
        for font, count in ascii_fonts.most_common():
            print(f"  ascii/hAnsi font       : {font!r} on {count} run(s)")
    distinct = len(east_asia_fonts)
    print(f"Distinct eastAsia fonts  : {distinct}")

    print(f"w:em emphasis dots       : {em_count}")
    print(f"w:u val=single           : {underline_single}")
    print(f"w:u val=wave             : {underline_wave}")

    if no_font_at_all:
        report.error(
            f"{no_font_at_all} run(s) have no <w:rFonts> at all: the font is "
            "inherited from the theme and is therefore not controlled"
        )
    if no_east_asia:
        report.error(
            f"{no_east_asia} run(s) do not set w:eastAsia: CJK glyphs will fall "
            "back to a theme font (this is the reference-docx anti-pattern)"
        )


# ----------------------------------------------------------------- tables ---


def check_tables(root: ET.Element, report: Report) -> None:
    """Report table dimensions and flag ragged rows."""
    tables = list(root.iter(qn("tbl")))
    print(f"Tables                   : {len(tables)}")

    for index, tbl in enumerate(tables, start=1):
        rows = tbl.findall(qn("tr"))
        counts = [len(tr.findall(qn("tc"))) for tr in rows]
        if counts:
            cols_desc = str(counts[0]) if len(set(counts)) == 1 else f"ragged {counts}"
        else:
            cols_desc = "0"
        print(f"  table {index}: {len(rows)} row(s) x {cols_desc} column(s)")
        if counts and len(set(counts)) != 1:
            report.error(
                f"table {index} has ragged rows: cell counts per row are {counts}"
            )
        if not rows:
            report.warn(f"table {index} has no rows")


# ----------------------------------------------------------- answer lines ---


def _run_is_underlined_space_run(r: ET.Element) -> bool:
    """识别被淘汰的空格下划线，不能算作字符答题线。"""
    text = "".join(t.text or "" for t in r.iter(qn("t"))).replace("\t", "")
    if not text or not text.isspace():
        return False
    u = r.find(f"{qn('rPr')}/{qn('u')}")
    return u is not None and (u.get(qn("val")) or "single") != "none"


def _answer_line_count(p: ET.Element) -> int:
    """统计实际字符横线；支持纯横线、答：、题干和表格里的多个填空。"""
    return len(re.findall(ANSWER_CHAR + "+", paragraph_text(p)))


def _is_answer_line_para(p: ET.Element) -> bool:
    return _answer_line_count(p) > 0


def check_answer_lines(root: ET.Element, report: Report) -> None:
    ruled = [p for p in root.iter(qn("p")) if _is_answer_line_para(p)]
    print(f"Answer-line paragraphs   : {len(ruled)} (U+FF3F characters)")
    print(f"Answer-line total lines  : {sum(_answer_line_count(p) for p in ruled)}")
    legacy = sum(1 for p in root.iter(qn("p"))
                 if any(_run_is_underlined_space_run(r) for r in p.iter(qn("r"))))
    if legacy:
        report.error(
            f"{legacy} paragraph(s) use underlined whitespace; "
            "use actual fullwidth underscore characters U+FF3F (＿) instead"
        )
    for p in root.iter(qn("p")):
        stripped = paragraph_text(p).strip()
        if stripped and set(stripped) == {"_"}:
            report.warn("ASCII '_' answer line found; use fullwidth U+FF3F (＿)")
    check_answer_line_geometry(root, report)
    check_questions_have_answer_space(root, report)


def check_answer_line_geometry(root: ET.Element, report: Report) -> None:
    """
    Structural checks that would have caught the "1.27cm answer line" bug.

    The bug: the helper emitted a leading <w:tab/> plus underlined fullwidth
    spaces, and tried to neutralise the tab with <w:tab w:val="left"
    w:pos="0"/> tab stops. A tab stop at position 0 is invalid OOXML — Word
    discards the whole w:tabs block, the tab falls back to
    defaultTabStop=720twips (1.27cm), and Word underlines only that tab because
    it does not underline trailing whitespace. Measured in Word: a 12.69mm
    rule in a 160mm column, which is exactly 1.27cm.

    Nothing about LINE_CHARS could have revealed it, because LINE_CHARS never
    reached the renderer. So check the constructs directly.

    This is cheap and deterministic, unlike looking at a rendered page.
    """
    zero_pos = 0
    for t in root.iter(qn("tab")):
        if t.get(qn("val")) is not None:  # a tab *stop* definition
            pos = t.get(qn("pos"))
            if pos is not None and int(pos) <= 0:
                zero_pos += 1

    if zero_pos:
        report.error(
            f"{zero_pos} tab stop(s) defined at w:pos=0. Position 0 is invalid "
            f"in OOXML (tab stops must increase) — Word silently discards the "
            f"whole w:tabs block, so any tab in the run advances to "
            f"defaultTabStop=720twips (1.27cm) and an underlined tab draws a "
            f"1.27cm stub instead of a full-width rule. This is what made the "
            f"answer lines short. Use fullwidth underscore characters U+FF3F (＿) instead."
        )

    # An underlined tab is the specific shape that produced the stub. Any
    # remaining occurrence is the legacy form and must not be introduced.
    underline_tabs: list[ET.Element] = []
    for r in root.iter(qn("r")):
        if r.find(qn("tab")) is None:
            continue
        rPr = r.find(qn("rPr"))
        if rPr is None:
            continue
        u = rPr.find(qn("u"))
        if u is not None and (u.get(qn("val")) or "single") != "none":
            underline_tabs.append(r)
            break

    if underline_tabs:
        report.error(
            "found an underlined <w:tab/> run. Word underlines only the tab "
            "itself (~1.27cm at the default tab stop) and skips the trailing "
            "whitespace after it, so this never produces a full-width rule. "
            "Replace with add_answer_lines() (U+FF3F characters)."
        )


# --------------------------------------------------------------------------- #
# 题型分类 —— 决定一道题要不要答题横线
# --------------------------------------------------------------------------- #
#
# 领域规则（老师定的，不是从分值猜的）：
#   **只有选择题不用给横线。其他题型都要。**
#   开放题 / 简答题 / 赏析题 / 概括题 / 论述题 / 翻译题 / 断句题 /
#   填空题（括号内空 / 横线上填）/ 字词解释 —— 全部需要横线。
#
# 选择题的识别特征：题干里出现「下列…正确的是 / 不正确的是 / 错误的是 /
# 符合题意的一项 / 是（  ）」这类"选一个"的说法，或者题号是 A/B/C/D 选项式。

# 题型 -> 需要横线？
_NEEDS_LINE_KINDS = {
    "开放式作答": True,   # 赏析/概括/阐述/说明理由/谈谈理解
    "翻译": True,
    "断句": True,
    "字词解释": True,
    "填空": True,
    "默写": True,
    "改写": True,
    "简答": True,
    "选择题": False,       # 唯一不需要横线的题型
    "判断": False,
}

# 闭合式作答信号：学生只需要从给出的选项里挑一个
_CLOSED_CUE = re.compile(
    r"下列[^。；\n]{0,20}?(?:正确|错误|不正确|不属于|符合题意|符合要求|是)"
    r"|是\s*[（(]\s*[）)]"
    r"|不属于[\s。]"
    r"|选出|选择一个"
)

# 开放式作答信号
_OPEN_CUE = re.compile(
    r"赏析|评价|体会|理解|说明理由|阐述|谈谈|简述|简要概括|概括"
    r"|归纳|总结|分析|比较|结合(?:材料|文本|内容)?[^。；\n]{0,10}?(?:谈谈|说说|阐述|分析)"
    r"|用现代汉语翻译|翻译|断句|解释下列|加点(?:的)?词|加点字|词的意思"
    r"|补写|默写|填空|按原文填空|请补充"
)

# 填空信号：题干里出现空的括号或空的横线占位
_BLANK_CUE = re.compile(r"_{3,}|＿{2,}|\(\s{3,}\)|（\s{2,}）")

# A question stem: "5.…" "(1)…"
_Q_STEM = re.compile(r"^\s*(?:\(?\d+\)?[.、．]|[（(]\d+[）)])\s*\S")
_POINTS = re.compile(r"[（(]\s*(\d+)\s*分\s*[）)]")
_SUB_Q = re.compile(r"^\s*[（(]\s*\d+\s*[）)]\s*\S")
_MATERIAL = re.compile(r"^\s*材料[一二三四五六七八九十\d]")


def classify_question(text: str, parent: str = "") -> str:
    """
    判断一道题是什么题型，决定要不要答题横线。

    返回 _NEEDS_LINE_KINDS 里的键。判断不出来时返回 None（不给结论，
    避免用启发式规则制造假警报）。
    """
    t = text.strip()
    if not t:
        return None
    ctx = f"{parent} {t}" if parent else t
    # 选择题的信号最强，优先判
    if _CLOSED_CUE.search(t):
        return "选择题"
    # 填空：题干/答案里本身有空位（横线或空括号）
    if _BLANK_CUE.search(t):
        return "填空"
    # 翻译（含 "8.用现代汉语翻译…" 下的 "(1)某句。（2分）" 这类只有句子的小题：
    # 小题本身没有动词，要靠父题干提供语境）
    if "翻译" in ctx or "译成现代汉语" in ctx:
        return "翻译"
    # 断句
    if "断句" in t or "用\"/\"" in t or "用“/”" in t:
        return "断句"
    # 字词解释（表格里"加点字/加点词解释"很常见）
    if "加点" in t or ("解释" in t and ("词" in t or "字" in t)):
        return "字词解释"
    # 填空类动词
    if any(k in t for k in ("补写", "默写", "按原文填空", "请补充")):
        return "填空"
    # 开放式作答
    if _OPEN_CUE.search(ctx):
        return "开放式作答"

    # 小题只剩一个短句 + 问号（例如 "…体现了怎样的智慧？"）也属于开放作答
    if re.search(r"怎样|如何|为什么|是什么|哪些|哪[些个]|多少", t) and ("？" in t or "?" in t):
        return "开放式作答"

    # 句子改写类
    if any(k in t for k in ("改为", "改成", "改写", "缩写", "扩写", "续写")):
        return "改写"
    return None


def _has_answer_line(el: ET.Element) -> bool:
    """段落或表格内是否含有实际的 U+FF3F 答题线字符。"""
    return any(_is_answer_line_para(p) for p in el.iter(qn("p")))


def check_questions_have_answer_space(root: ET.Element, report: Report) -> None:
    """
    按题型检查答题空间。

    规则：**只有选择题不用横线，其他题型都要。** 填空题也要横线
    （横线是学生填的位置）。

    父题干（后面紧跟子题的引导句，如「5.根据要求，完成题目。（6分）」）
    本身不需要横线，因为它的子题各自带横线。
    """
    body = root.find(qn("body"))
    if body is None:
        return

    blocks: list[tuple[str, ET.Element]] = []
    for el in body:
        if el.tag == qn("p"):
            blocks.append(("p", el))
        elif el.tag == qn("tbl"):
            blocks.append(("tbl", el))

    missing: list[str] = []
    thin: list[str] = []

    # Group stems into "parent + its sub-questions".
    #
    #   5.根据要求，完成题目。（6分）      <- parent (numbered  N.)
    #   (1)赏析…（3分）                     <- sub-question
    #   (2)阅读材料…（3分）                  <- sub-question
    #   6.用"/"…断句。（2分）              <- new parent / standalone
    #
    # A stem is a PARENT when it is numbered "N." and the following stems are
    # "(n)" until the next "N." (or a material heading). Numbering style is the
    # reliable signal; adjacency alone is not, because a parent can be followed
    # by another parent.
    def stem_number(text: str) -> str:
        """Return "N" for "N.…", "sub<n>" for "(n)…", or "" for anything else."""
        m = re.match(r"^\s*(\d+)\s*[.、．]", text)
        if m:
            return m.group(1)
        m = re.match(r"^\s*[（(]\s*(\d+)\s*[）)]", text)
        if m:
            return "sub" + m.group(1)
        return ""

    def is_answer_line_block(el: ET.Element) -> bool:
        return _has_answer_line(el)

    # 表格和题干中的每个字符填空也计入答题空间。
    def _rule_count(el: ET.Element) -> int:
        return sum(_answer_line_count(p) for p in el.iter(qn("p")))

    info: list[dict] = []
    for _kind, el in blocks:
        if el.tag != qn("p"):
            info.append({
                "el": el,
                "text": "",
                "stem": "",
                "line": is_answer_line_block(el),
                "count": _rule_count(el),
            })
            continue
        text = paragraph_text(el).strip()
        info.append({
            "el": el,
            "text": text,
            "stem": stem_number(text) if text else "",
            "line": is_answer_line_block(el),
            "count": _rule_count(el),
        })

    # A parent is a "N." stem that is followed — ignoring answer lines and
    # blank paragraphs — by a "(n)" stem. Only then do the sub-questions carry
    # the answer space; the parent itself does not need a line.
    parent_idx: set[int] = set()
    for i, d in enumerate(info):
        if not d["stem"] or d["stem"].startswith("sub"):
            continue
        for j in range(i + 1, len(info)):
            e = info[j]
            if (e["line"] and not e["stem"]) or not e["text"]:
                continue          # skip answer lines / blanks
            if e["stem"].startswith("sub"):
                parent_idx.add(i)
            break

    # Each sub-question inherits the nearest preceding parent's wording.
    parent_text_of: dict[int, str] = {}
    cur = ""
    for i, d in enumerate(info):
        if (d["line"] and not d["stem"]) or not d["text"]:
            continue
        num = d["stem"]
        if num.startswith("sub"):
            if cur:
                parent_text_of[i] = cur
        elif num:
            cur = d["text"]

    missing: list[str] = []
    for i, d in enumerate(info):
        if not d["text"] or not _Q_STEM.match(d["text"]):
            continue
        if i in parent_idx:
            continue  # sub-questions carry the lines

        kind_name = classify_question(d["text"], parent=parent_text_of.get(i, ""))
        if kind_name is None or not _NEEDS_LINE_KINDS[kind_name]:
            continue  # 选择题 / 判断题 / 判断不出来

        # Look ahead (skipping answer lines and blanks) for the next stem or
        # material heading; lines in between satisfy the requirement.
        count = d["count"]
        found = count > 0
        for j in range(i + 1, len(info)):
            e = info[j]
            if e["stem"] or _MATERIAL.match(e["text"]):
                break
            if e["line"]:
                found = True
                count += max(1, e["count"])
                continue          # keep counting: a big question needs several
            if not e["text"]:
                continue
            if _Q_STEM.match(e["text"]) or _MATERIAL.match(e["text"]):
                break
            # Plain body text (a poem line, the sentence to be punctuated)
            # does not end the answer area, but a heading does.
            if _MATERIAL.match(e["text"]):
                break

        if not found:
            missing.append(f"[{kind_name}] {d['text'][:32]}")
            continue

        # Line *count*: at least one rule per point. A 6-mark essay gets one
        # line and the student runs out of room, which is a real defect the
        # teacher notices immediately.
        m = _POINTS.search(d["text"])
        if m:
            pts = int(m.group(1))
            need = max(1, pts * MIN_LINES_PER_POINT)
            if count < need:
                thin.append(
                    f"{d['text'][:28]} ({pts}分 → 需 {need} 行，实给 {count} 行)"
                )

    if missing:
        report.error(
            f"{len(missing)} question(s) need answer lines but have none before "
            f"the next question (只有选择题不用横线，其他题型都要): "
            + "; ".join(f"\"{m}\"" for m in missing[:4])
            + ("; ..." if len(missing) > 4 else "")
        )

    if thin:
        report.warn(
            f"{len(thin)} question(s) have fewer answer lines than their point "
            f"value implies ({MIN_LINES_PER_POINT} line per point): "
            + "; ".join(thin[:4])
            + ("; ..." if len(thin) > 4 else "")
        )


def verify(path: str) -> int:
    report = Report()

    print("=" * 72)
    print(f"PaperForge verify: {path}")
    print("=" * 72)

    try:
        root = load_document_xml(path)
    except (zipfile.BadZipFile, ValueError, ET.ParseError, OSError) as exc:
        print(f"ERROR: cannot read {path}: {exc}")
        return 1

    check_sections(root, report)
    print("-" * 72)
    check_paragraphs(root, report)
    print("-" * 72)
    check_runs(root, report)
    print("-" * 72)
    check_tables(root, report)
    print("-" * 72)
    check_answer_lines(root, report)

    print("=" * 72)
    errors = [f for f in report.findings if f.level == "ERROR"]
    warns = [f for f in report.findings if f.level == "WARN"]
    infos = [f for f in report.findings if f.level == "INFO"]

    for f in errors:
        print(f"ERROR: {f.message}")
    for f in warns:
        print(f"WARN : {f.message}")
    for f in infos:
        print(f"INFO : {f.message}")

    print("-" * 72)
    print(f"RESULT: {len(errors)} error(s), {len(warns)} warning(s)")
    print("VERDICT: FAIL" if errors else "VERDICT: PASS")
    return 1 if errors else 0


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__.strip(), file=sys.stderr)
        return 1
    return verify(argv[1])


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
