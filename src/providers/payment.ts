import { config } from "../config.js";

// 全凭自觉付费：只展示微信收款码，不做任何门槛/校验/回调。
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
