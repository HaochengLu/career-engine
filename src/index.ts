// 本地开发入口：启动 HTTP 服务。Vercel 部署走 api/index.ts。
import "dotenv/config";
import { app } from "./app.js";
import { config } from "./config.js";

const activeModel =
  config.provider === "openai" ? config.openai.model : config.provider === "anthropic" ? config.defaultModel : "mock";

app.listen(config.port, () => {
  console.log(`career-engine 已启动: http://localhost:${config.port}  (provider=${config.provider}, model=${activeModel})`);
});
