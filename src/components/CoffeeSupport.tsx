import Image from "next/image";
import { coffeePaymentMethods as methods } from "@/lib/coffee-support";

/** Public image paths, configured before building; never invent a payment code. */
export default function CoffeeSupport() {
  if (methods.length === 0) return null;
  return (
    <section className="lp-wrap lp-section lp-coffee" id="coffee" aria-labelledby="coffee-title">
      <div className="lp-coffee-copy">
        <svg className="lp-coffee-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 9h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9Z" />
          <path d="M17 10h2a3 3 0 0 1 0 6h-2M7 3v3m4-3v3m4-3v3M3 22h16" />
        </svg>
        <h2 id="coffee-title">请我喝杯咖啡</h2>
        <p>如果 PaperForge 帮你省下了一点时间，<br />欢迎请我喝杯咖啡，支持我继续维护它。</p>
        <p className="lp-coffee-note">自愿支持，金额随意。赞助不会增加生成次数，也不影响内测申请与正常使用。</p>
      </div>
      <div className="lp-coffee-payment">
        {methods.length > 0 ? (
          <>
            <div className="lp-coffee-codes">
              {methods.map((method) => (
                <figure key={method.name} className="lp-coffee-code">
                  <a href={method.src} target="_blank" rel="noopener noreferrer" aria-label={`打开${method.name}收款码原图`}>
                    <Image src={method.src} alt={`${method.name}赞助收款码`} width={1118} height={1524} unoptimized />
                  </a>
                  <figcaption>{method.name}</figcaption>
                </figure>
              ))}
            </div>
            <p>扫码即可支持。手机上可点开原图，保存后在对应支付应用中识别。</p>
          </>
        ) : (
          <div className="lp-coffee-empty">
            <strong>收款码还在准备中</strong>
            <p>谢谢你的心意！暂时也欢迎通过「反馈与建议」告诉我使用感受。</p>
          </div>
        )}
      </div>
    </section>
  );
}
