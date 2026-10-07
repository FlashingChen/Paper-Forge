"""Regression tests for character answer areas and their validator."""
import contextlib
import io
import sys
import tempfile
import unittest
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent" / "snippets"))
sys.path.insert(0, str(ROOT / "scripts"))
import docx_helpers as h
import verify as v


def xml(doc):
    return ET.fromstring(doc.element.xml)


class AnswerLinesTest(unittest.TestCase):
    def check_answers(self, doc):
        report = v.Report()
        with contextlib.redirect_stdout(io.StringIO()):
            v.check_answer_lines(xml(doc), report)
        return report

    def test_multiline_characters_pass_full_verifier(self):
        doc = h.new_doc()
        h.add_para(doc, "1.请结合材料阐述理由。（3分）")
        lines = h.add_answer_lines(doc, 3, prefix="答：")
        self.assertEqual([p.text for p in lines],
                         ["答：" + "＿" * 36, "＿" * 38, "＿" * 38])
        self.assertFalse(doc.element.xpath(".//w:pBdr"))
        self.assertFalse(doc.element.xpath(".//w:u"))
        self.assertFalse(doc.element.xpath(".//w:tab"))
        self.assertEqual(lines[0].runs[0].font.name, "楷体")
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "paper.docx"
            doc.save(path)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(v.verify(str(path)), 0)

    def test_table_fill_is_inline_and_blank_header_stays_blank(self):
        doc = h.new_doc()
        h.add_para(doc, "1.解释下列加点的词。（2分）")
        table = h.add_table(doc, [["", "释义"],
                                 ["趋", "（1）" + h.answer_fill()],
                                 ["顾", "（2）" + h.answer_fill(5)]],
                            widths_mm=[80, 80])
        self.assertEqual(table.cell(0, 0).text, "")
        self.assertEqual(table.cell(1, 1).text, "（1）" + "＿" * 7)
        self.assertEqual(table.cell(1, 1).paragraphs[0].runs[-1].font.name, "楷体")
        self.assertFalse(doc.element.xpath(".//w:pBdr"))
        self.assertEqual(self.check_answers(doc).findings, [])

    def test_inline_stem_counts_its_own_blanks(self):
        doc = h.new_doc()
        h.add_para(doc, "1.补写：晨风吹过树梢，" + h.answer_fill(8) + "。（1分）")
        self.assertEqual(self.check_answers(doc).findings, [])

    def test_next_question_inline_blank_cannot_answer_previous_question(self):
        doc = h.new_doc()
        h.add_para(doc, "1.请简要概括文章内容。（1分）")
        h.add_para(doc, "2.补写：晨风吹过树梢，" + h.answer_fill(8) + "。（1分）")
        report = self.check_answers(doc)
        self.assertEqual(report.error_count, 1)
        self.assertIn("1.请简要概括", report.findings[0].message)

    def test_old_border_rules_are_rejected_and_not_counted(self):
        doc = h.new_doc()
        h.add_para(doc, "1.请简要概括文章内容。（3分）")
        for _ in range(3):
            p = doc.add_paragraph()
            border = h.OxmlElement("w:pBdr")
            bottom = h.OxmlElement("w:bottom")
            bottom.set(h.qn("w:val"), "single")
            border.append(bottom)
            p._p.get_or_add_pPr().append(border)
        report = self.check_answers(doc)
        with contextlib.redirect_stdout(io.StringIO()):
            v.check_paragraphs(xml(doc), report)
        self.assertGreaterEqual(report.error_count, 2)

    def test_large_type_and_narrow_cell_shorten_without_new_paragraphs(self):
        doc = h.new_doc()
        line = h.add_answer_lines(doc, 1, size_pt=18, prefix="答：")[0]
        self.assertLess(line.text.count("＿"), 36)
        table = h.add_table(doc, [["（1）", "文字"]], widths_mm=[25, 135])
        cell = table.cell(0, 0)
        h.add_answer_line_inline(cell, chars=30)
        self.assertEqual(len(cell.paragraphs), 1)
        self.assertTrue(cell.text.startswith("（1）＿"))
        self.assertLess(cell.text.count("＿"), 7)

    def test_rich_text_preserves_text_marks_but_not_on_answer_characters(self):
        doc = h.new_doc()
        p = h.add_rich_para(doc, [("词语" + h.answer_fill(), {"underline": "wave"})])
        self.assertEqual(p.runs[0].font.name, "宋体")
        self.assertEqual(p.runs[1].font.name, "楷体")
        self.assertFalse(p.runs[1]._r.xpath("./w:rPr/w:u"))
        self.assertTrue(p.runs[0]._r.xpath("./w:rPr/w:u"))

    def test_shipped_reference_matches_character_line_contract(self):
        path = ROOT / "reference" / "sample-worksheet.docx"
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(v.verify(str(path)), 0)
        doc = h.Document(path)
        lines = [p.text for p in doc.paragraphs if "＿" in p.text]
        self.assertEqual(lines, ["答：" + "＿" * 36, "＿" * 38])

    def test_whitespace_underlining_is_rejected(self):
        doc = h.new_doc()
        run = h.add_para(doc, "　" * 10).runs[0]
        run.underline = True
        self.assertGreater(self.check_answers(doc).error_count, 0)


if __name__ == "__main__":
    unittest.main()
