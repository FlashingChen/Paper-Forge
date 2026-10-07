/** Public image paths configured at build time. */
export const coffeePaymentMethods = [
  { name: "微信", src: process.env.NEXT_PUBLIC_COFFEE_WECHAT_QR?.trim() },
  { name: "支付宝", src: process.env.NEXT_PUBLIC_COFFEE_ALIPAY_QR?.trim() },
].filter((method): method is { name: string; src: string } =>
  Boolean(method.src?.startsWith("/") && !method.src.startsWith("//")),
);
