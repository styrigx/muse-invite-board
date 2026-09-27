# Muse 邀请码共享站

五平台架构：用户在 Vercel 页面点抽码 → 请求打到 Workers API → Workers 查 Supabase → 返回结果；Actions 每天半夜打扫卫生。

| 平台 | 职责 |
|---|---|
| Vercel (`web/`) | 前端页面，负责好看 |
| Cloudflare Workers (`worker.js`) | API 层：抽码 / 提交 / 投票 |
| Supabase | Postgres 数据库：码池、投票记录 |
| Workers AI | 每天生成一句推荐语，存 KV，首页展示 |
| GitHub Actions | 每天凌晨清理被标记 3 次的失效码 + 备份全表到 `backups/` |

- `worker.js` 环境变量：`SUPABASE_URL`、`SUPABASE_ANON_KEY`（Secret）、`INVITE_KV`（KV 绑定，仅限流）、`AI`（Workers AI 绑定）。Cron Trigger：`0 1 * * *`。
- `web/index.html` 纯静态单文件，Vercel 部署时 Root Directory 选 `web`。
- `.github/workflows/cleanup.yml` 需仓库 Secrets：`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`。
