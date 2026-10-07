import Image from "next/image";
import { coffeePaymentMethods } from "@/lib/coffee-support";

export default function JobCoffeeSupport() {
  if (coffeePaymentMethods.length === 0) return null;
  return (
    <details className="job-coffee">
      <summary>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 9h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9Z" />
          <path d="M17 10h2a3 3 0 0 1 0 6h-2M7 3v3m4-3v3m4-3v3M3 22h16" />
        </svg>
        <span>请我喝杯咖啡</span>
        <span className="job-coffee-toggle">查看收款码 <span aria-hidden="true">▾</span></span>
      </summary>
      <div className="job-coffee-body">
        <p>自愿支持，金额随意。谢谢你支持 PaperForge 继续维护。</p>
        <div className="job-coffee-codes">
          {coffeePaymentMethods.map((method) => (
            <figure key={method.name}>
              <a href={method.src} target="_blank" rel="noopener noreferrer" aria-label={`打开${method.name}收款码原图`}>
                <Image src={method.src} alt={`${method.name}赞助收款码`} width={1118} height={1524} unoptimized />
              </a>
              <figcaption>{method.name}</figcaption>
            </figure>
          ))}
        </div>
        <p className="hintline">手机上可点开原图，保存后在支付应用中识别。赞助不会增加生成次数，也不影响正常使用。</p>
      </div>
    </details>
  );
}
