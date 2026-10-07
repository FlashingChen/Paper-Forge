import io
import base64
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent" / "snippets"))
import docx_helpers as h
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import docx_preview as preview


class CroppedFiguresTest(unittest.TestCase):
    def test_crop_is_embedded_with_original_pixels_and_aspect_ratio(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, crop = root / "source.png", root / "crops" / "q1.jpg"
            image = Image.new("RGB", (200, 100), "white")
            image.paste("black", (40, 20, 160, 80))
            image.save(source)
            doc = h.new_doc()
            h.add_para(doc, "1.如图，求面积。")
            h.add_cropped_figure(doc, source, (40, 20, 160, 80), crop, width_mm=300)
            result = root / "result.docx"
            doc.save(result)
            with zipfile.ZipFile(result) as archive:
                media = [name for name in archive.namelist() if name.startswith("word/media/")]
                self.assertEqual(len(media), 1)
                with Image.open(io.BytesIO(archive.read(media[0]))) as embedded:
                    self.assertEqual(embedded.size, (120, 60))
                    self.assertEqual(embedded.getpixel((60, 30)), (0, 0, 0))
            payload = preview.build_preview(str(result))
            pictures = [picture for block in payload["blocks"] if block["type"] == "p"
                        for run in block["runs"] for picture in run.get("images", [])]
            self.assertEqual(len(pictures), 1)
            self.assertAlmostEqual(pictures[0]["widthPx"] / pictures[0]["heightPx"], 2, places=2)
            self.assertEqual(base64.b64decode(pictures[0]["src"].split(",", 1)[1]), crop.read_bytes())
            self.assertFalse(any("图片" in warning for warning in payload["warnings"]))
            shape = doc.inline_shapes[0]
            self.assertAlmostEqual(shape.width / shape.height, 2)
            self.assertLessEqual(shape.width, doc.sections[0].page_width - doc.sections[0].left_margin - doc.sections[0].right_margin)
            with Image.open(source) as original:
                self.assertEqual(original.size, (200, 100))
            with self.assertRaises(ValueError):
                h.add_cropped_figure(doc, source, (-1, 20, 160, 80), crop)

    def test_preview_keeps_images_between_text_runs_and_skips_external_images(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            picture = root / "image.png"
            Image.new("RGB", (20, 10), "black").save(picture)
            doc = h.new_doc()
            paragraph = doc.add_paragraph()
            h.set_font(paragraph.add_run("A."))
            h.set_font(paragraph.add_run()).add_picture(str(picture))
            h.set_font(paragraph.add_run("B."))
            result = root / "result.docx"
            doc.save(result)
            runs = preview.build_preview(str(result))["blocks"][0]["runs"]
            self.assertEqual([run["text"] for run in runs], ["A.", "", "B."])
            self.assertEqual(len(runs[1]["images"]), 1)
            external = root / "external.docx"
            with zipfile.ZipFile(result) as source, zipfile.ZipFile(external, "w") as target:
                for entry in source.infolist():
                    data = source.read(entry)
                    if entry.filename == "word/_rels/document.xml.rels":
                        data = data.replace(b'Target="media/image1.png"', b'Target="https://example.invalid/image.png" TargetMode="External"')
                    target.writestr(entry, data)
            payload = preview.build_preview(str(external))
            self.assertFalse(any(run.get("images") for block in payload["blocks"] for run in block.get("runs", [])))
            self.assertTrue(any("未显示" in warning for warning in payload["warnings"]))

    def test_crop_coordinates_follow_exif_orientation(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "rotated.jpg"
            image = Image.new("RGB", (200, 100), "white")
            exif = image.getexif()
            exif[274] = 6
            image.save(source, exif=exif)
            h.add_cropped_figure(h.new_doc(), source, (0, 100, 100, 200), root / "crop.jpg")
            with Image.open(root / "crop.jpg") as crop:
                self.assertEqual(crop.size, (100, 100))


if __name__ == "__main__":
    unittest.main()
