// Vercel serverless 入口：复用同一个 Express app 作为 handler。
// 静态文件（public/ 下的 index.html、支付二维码 png）由 Vercel 平台直接托管；
// 其余路由（/api/report/generate 等）经 vercel.json 改写到本函数。
import app from "../src/app.js";

export default app;
