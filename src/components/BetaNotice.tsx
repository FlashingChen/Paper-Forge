import Link from "next/link";
import { BETA_CONTACT } from "@/lib/beta-contact";
export default function BetaNotice() {
  return (
    <aside className="beta-notice" aria-label="内测试用说明">
      <span className="beta-badge">正在内测</span>
      <div>
        <p>还没有账号？<Link href="/register"><strong>申请内测</strong></Link>，通过后就能用</p>
        <p className="beta-note">审核或使用中有问题，都可以私信 {BETA_CONTACT}。尚未正式上线，欢迎把问题和建议告诉我。</p>
      </div>
    </aside>
  );
}
