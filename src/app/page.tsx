import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import CoffeeSupport from "@/components/CoffeeSupport";
import "./landing.css";

export const metadata: Metadata = {
  title: "拍照转 Word · PaperForge",
  description: "拍下纸质练习卷，自动还原成可编辑、可打印的 Word 文档。",
};

const STEPS = [
  { n: "01", label: "UPLOAD", title: "拍下练习卷", text: "支持 JPG、PNG，一次最多 20 张。上传后调整页序，让每一页都在正确的位置。" },
  { n: "02", label: "RECOGNIZE", title: "交给 AI 识别", text: "识别题目与版面，保留原文内容。看不清的地方会写入识别备注，方便你核对。" },
  { n: "03", label: "DOWNLOAD", title: "拿到 Word", text: "下载可编辑的 .docx。宋体、A4、20mm 页边距，答题横线也已排好。" },
];
const FEATURES = [
  { n: "01", title: "多页试卷，按序还原", text: "移动缩略图就能调整页序，也可以单张删除。整理好再开始生成。" },
  { n: "02", title: "关掉页面，任务继续", text: "生成期间可以离开页面，稍后回到任务链接查看进度、下载结果。" },
  { n: "03", title: "留出足够的答题空间", text: "按题型和分值安排答题横线。下载后还能在 Word 中继续编辑。" },
];
const FAQ = [
  { q: "需要安装软件吗？", a: "不用，手机和电脑的浏览器都能上传照片、查看进度和下载文档。编辑下载的文件需要使用兼容 .docx 的软件。" },
  { q: "一次可以上传多少张照片？", a: "一次最多 20 张，支持 JPG 和 PNG。多页试卷建议一次上传，并在生成前确认页序。" },
  { q: "生成后可以直接打印吗？", a: "文档按宋体、A4 和 20mm 页边距排版，并留出答题横线。打印前请核对题目和识别备注，也可以自行调整版面。" },
  { q: "怎样获取账号？", a: "点「申请内测」填用户名、密码、职业和省份就能提交申请。通过后会给你开通账号和配额，回到这里点「开始使用」即可。" },
];

function StartLink({ children = "开始使用", small = false }: { children?: React.ReactNode; small?: boolean }) {
  return <Link className={`lp-btn lp-btn-primary${small ? " lp-btn-small" : ""}`} href="/app">{children}<span aria-hidden="true">→</span></Link>;
}

function ExamplePanel({ result = false }: { result?: boolean }) {
  return (
    <figure className={`lp-example${result ? " lp-example-result" : ""}`}>
      <div className="lp-window-bar"><span className="lp-file-label">{result ? "OUTPUT / .DOCX" : "INPUT / .JPG"}</span><span className="lp-window-dots" aria-hidden="true"><i /><i /><i /></span></div>
      <div className="lp-example-image"><Image src={result ? "/examples/workbook-word.jpg" : "/examples/workbook-photo.jpg"} alt={result ? "AI 生成的同篇原创阅读练习 Word 示意，文章、表格与答题线整齐排列" : "AI 生成的原创阅读练习书页示意，装订处深阴影、弯曲文字与透视变形明显"} width={1100} height={1100} sizes="(max-width: 680px) 90vw, (max-width: 960px) 42vw, 425px" priority /></div>
      <figcaption><span>{result ? "生成后的 Word" : "拍下来的原卷"}</span><span className="lp-example-tag">{result ? "可编辑 · 可打印" : "弯曲书页 · 透视变形"}</span></figcaption>
    </figure>
  );
}

export default function LandingPage() {
  return (
    <div className="lp">
      <a className="lp-skip" href="#main">跳到主要内容</a>
      <nav className="lp-nav" aria-label="主导航"><div className="lp-wrap lp-nav-in">
        <Link className="lp-brand" href="/" aria-label="PaperForge 首页"><span className="lp-mark" aria-hidden="true">P</span><span>PAPERFORGE</span></Link>
        <div className="lp-nav-links"><a href="#how">使用流程</a><a href="#result">效果预览</a><a href="#faq">常见问题</a><Link href="/register">申请内测</Link></div>
        <StartLink small>开始使用</StartLink>
      </div></nav>
      <main id="main">
        <header className="lp-wrap lp-hero">
          <div className="lp-eyebrow"><span aria-hidden="true" />正在内测 · 欢迎试用</div>
          <p className="lp-hero-kicker" aria-hidden="true">PHOTO → WORD</p>
          <h1>拍下练习卷，<br />把<span className="lp-highlight">排版</span>交给 PaperForge<span className="lp-cursor" aria-hidden="true">_</span></h1>
          <p className="lp-lead">不用再对着照片一行行打字。上传纸质试卷，<br className="lp-desktop-break" />拿到一份可编辑、可打印的 Word。</p>
          <div className="lp-cta-row"><StartLink /><Link className="lp-btn lp-btn-secondary" href="/register">申请内测<span aria-hidden="true">→</span></Link><a className="lp-btn lp-btn-secondary" href="#result">查看效果<span aria-hidden="true">↓</span></a></div>
          <p className="lp-hero-note">内测期间要先申请账号，通过后才能上传照片：<Link href="/register">申请内测</Link></p>
          <div className="lp-specs" aria-label="输出格式"><span><b>DOCX</b> 可编辑文档</span><span><b>A4</b> 标准纸张</span><span><b>宋体</b> 清晰排版</span><span><b>20mm</b> 页边距</span></div>
        </header>
        <section className="lp-wrap lp-section lp-result-section" id="result" aria-labelledby="result-title">
          <div className="lp-section-heading"><div><p className="lp-section-code">PREVIEW / 01</p><h2 id="result-title">从一张照片，到一份新卷子</h2></div><p className="lp-section-description">保留题目，重新整理版面。<br />让纸上的内容，回到可以修改的状态。</p></div>
          <div className="lp-compare"><ExamplePanel /><span className="lp-convert" aria-hidden="true">→</span><ExamplePanel result /></div>
          <p className="lp-demo-note">AI 生成示意图 · 使用原创虚构题目展示拍照与排版效果，非实际转换结果。</p>
        </section>
        <section className="lp-wrap lp-section" id="how" aria-labelledby="how-title">
          <div className="lp-section-heading"><div><p className="lp-section-code">HOW IT WORKS / 02</p><h2 id="how-title">只需要三步</h2></div><p className="lp-section-description">拍照、上传、下载。<br />中间的识别和排版，交给它完成。</p></div>
          <div className="lp-steps">{STEPS.map(step => <article className="lp-step" key={step.n}><div className="lp-step-top"><span className="lp-step-number">{step.n}</span><span className="lp-step-label">{step.label}</span></div><h3>{step.title}</h3><p>{step.text}</p></article>)}</div>
        </section>
        <section className="lp-wrap lp-section" aria-labelledby="features-title">
          <div className="lp-section-heading"><div><p className="lp-section-code">BUILT FOR TEACHING / 03</p><h2 id="features-title">少一点重复，多一点从容</h2></div></div>
          <div className="lp-features">{FEATURES.map(feature => <article className="lp-feature" key={feature.n}><span className="lp-feature-mark" aria-hidden="true">{feature.n}</span><div><h3>{feature.title}</h3><p>{feature.text}</p></div></article>)}</div>
        </section>
        <section className="lp-wrap lp-section lp-faq-section" id="faq" aria-labelledby="faq-title">
          <div><p className="lp-section-code">FAQ / 04</p><h2 id="faq-title">开始之前，<br />你可能想知道</h2></div>
          <div className="lp-faq">{FAQ.map(item => <details key={item.q}><summary>{item.q}</summary><p>{item.a}</p></details>)}</div>
        </section>
        <section className="lp-wrap lp-section"><div className="lp-final-cta"><div><p className="lp-section-code">READY TO START?</p><h2>下一份练习卷，<br />从拍照开始。</h2><p>准备好照片，剩下的交给 PaperForge。</p></div><StartLink /></div></section>
        <CoffeeSupport />
      </main>
      <footer className="lp-wrap lp-footer"><div><Link className="lp-brand" href="/"><span className="lp-mark" aria-hidden="true">P</span><span>PAPERFORGE</span></Link><span>拍照转 Word，让备课轻一点。</span></div><p>请确保您上传和处理的内容拥有合法使用权，或属于教学、研究等法律允许的合理使用范围。</p></footer>
    </div>
  );
}
