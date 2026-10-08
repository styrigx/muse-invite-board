# Muse 码池

![Muse 码池](web/og-image.png)

Muse 邀请码自助共享站：拿一个码，留一个码。线上地址：**https://muse-invite.styrigx.com**

## 功能要点

- **抽码**：加权轮换算法，被抽得少的码优先展示，新码权重最高，不会被秒烧。
- **贡献码**：提交 6 位邀请码，Cloudflare Turnstile 人机验证后入池。
- **投票**：「👍 能用」票打标「✓ 已核验」；「标记失效」1 次即撤下展示，3 次自动隐藏；误标可用「能用」票恢复。
- **跑马灯**：最近发放记录滚动展示。
- **每日一句**：Workers AI 每天生成一句推荐语，存 KV，首页展示。
- **留言板**：每 IP 一条，KV 存储。
- **隐私**：无账号、无个人署名。页脚只有 Privacy。

## 技术栈

| 层 | 平台 |
|---|---|
| 前端 | Cloudflare Pages（`web/`，纯静态单文件） |
| API | Cloudflare Worker（`worker.js`：抽码 / 提交 / 投票 / 留言 / 每日推荐语） |
| 数据库 | Supabase Postgres（`codes` 表：码池、投票记录） |
| 限流 / 缓存 | Workers KV（抽码限流、留言、推荐语、暂停标记） |
| 每日任务 | GitHub Actions（清理被标记 3 次的失效码 + 备份全表到 `backups/`，只保留最近 7 天） |

数据流：用户在页面点抽码 → 请求打到 Worker API → Worker 查 Supabase → 返回结果；Actions 每天凌晨打扫卫生。

## 本地开发

```bash
# 前端：直接用任意静态服务器打开 web/
cd web && python3 -m http.server 8000

# Worker：需要先填环境变量再 wrangler dev
npx wrangler dev
```

前端默认请求 `https://muse-invite-board.styrigx.workers.dev` 上的 API；本地联调可把 `web/index.html` 里的 `API` 常量改成 `http://localhost:8787`。

## 部署

### 前端（Cloudflare Pages）

1. Pages 新建项目，连接本仓库。
2. Root Directory 选 `web`，其余默认。

### 后端（Cloudflare Worker）

```bash
npx wrangler deploy
```

环境变量（`wrangler.toml` 的 `[vars]`，明文）：`SUPABASE_URL`。
Secrets（Dashboard 或 `wrangler secret put`）：`SUPABASE_ANON_KEY`、`TURNSTILE_SECRET`。
Bindings：KV `INVITE_KV`、Workers AI `AI`。Cron Trigger：`0 1 * * *`（每天生成推荐语）。

注意：`wrangler deploy` 会用 `wrangler.toml` 整体替换 Worker 配置，明文变量必须写在 `[vars]` 里，否则会被清空。

### 每日清理（GitHub Actions）

仓库 Secrets 配置 `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`。工作流 `.github/workflows/cleanup.yml` 每天北京时间凌晨 2 点运行：备份 `codes` 全表到 `backups/`（只保留最近 7 天），删除被标记 3 次的失效码（站长码跳过）。

## 目录结构

```
web/                  前端（index.html 单文件 + og-image.png）
worker.js             Worker 完整代码
worker-code.txt       worker.js 的同步副本（Dashboard 手动粘贴用）
wrangler.toml         Worker 配置（变量写全，避免 deploy 清空）
backups/              Actions 每日备份（只保留最近 7 天）
make_og.py            生成社交分享卡 og-image.png 的脚本
.github/workflows/    每日清理 + 备份工作流
```

## 许可证与致谢

MIT License，Copyright (c) 2026 Sloan Gray，见 [LICENSE](LICENSE)。

## 相关项目

- 主站 Styrigx's Space：https://styrigx.com（styrigx/styrigx-space）
- 博客：https://blog.styrigx.com（styrigx/styrigx-blog）
- 书站：https://book.styrigx.com（styrigx/styrigx-book）

---

## English summary

Muse Invite Code Board — a community self-service board for sharing Muse invite codes. Take one, leave one. Live at https://muse-invite.styrigx.com. Frontend on Cloudflare Pages, API on Cloudflare Worker, Postgres on Supabase, rate limiting on Workers KV, daily cleanup via GitHub Actions. MIT licensed, © 2026 Sloan Gray.
