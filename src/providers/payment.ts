import { config } from "../config.js";

// 支付二维码配置：图片作为静态资源托管，真实生产可替换为正式支付系统。
export interface PaymentInfo {
  qrTrial: string;
  qrFull: string;
  qrCustom: string;
}

export function getPaymentInfo(): PaymentInfo {
  return {
    qrTrial: config.payment.qrTrial,
    qrFull: config.payment.qrFull,
    qrCustom: config.payment.qrCustom,
  };
}
