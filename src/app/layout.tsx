import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "拍照转 Word",
  description: "拍下试卷照片，自动还原成可以打印的 Word 文档。",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Matches the HUD bar background so the mobile browser chrome blends in.
  themeColor: "#0b1016",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
