# face — Claude.ai 风格前端壳

这个目录是移植进来的仿 Claude.ai 官方 UI 前端（单文件 `index.html` + 设计系统 CSS），
后端已从原项目的 Claude Agent SDK 整个替换为 paramecium 网关。
适配层在 `chat-api/face-api.mjs`，由 `server.mjs` 委托处理 `/api/*` 和静态文件。

## 铁律

**`index.html` 的界面不动。** 只允许在侧边栏 / 顶部下拉菜单里做条目增减。
这张脸是选它的唯一理由，改坏了就什么都不剩了。

## 架构

```
浏览器（face/index.html）
    │  /api/chat 等（Bearer token + named SSE events）
    ▼
chat-api/face-api.mjs        ← 方言翻译：认证、静态文件、/api 契约
    │  handleGatewaySend()（进程内调用）
    ▼
chat-api/gateway.mjs         ← prompt 组装、BP1-4 缓存、记忆注入、工具循环
    │
    ▼
上游 API（Anthropic / OpenAI 兼容）
```

对话的唯一真相在网关侧（`/opt/chat-api/data/*.json`），前端只是显示器。
换设备、换浏览器，历史都在。

## 已接通的端点

| face 端点 | 落点 |
|---|---|
| `POST /api/auth` | HMAC token（同原项目 auth.py 方案） |
| `POST /api/chat` | `handleGatewaySend`，SSE 逐事件翻译（delta/thinking/tool_use/tool_result/done/error） |
| `GET /api/sessions` + messages/title/star/DELETE | 网关侧对话 JSON 文件 |
| `POST /api/upload` + `GET /api/uploads/…` | `/opt/chat-api/uploads/`（图片走网关 image_data 通道，原件落盘） |
| `GET/PUT /api/memory` | L2 画像层 `profile/user.md` 在线编辑 |
| `GET /api/diary` | vault 日记（`memories.json` 的日记分类） |
| `GET/PUT /api/profile`、`POST /api/profile/memory` | `data/face-profile.json`（face 自己的偏好） |
| `GET /api/models` | `settings.json` 的 accounts 列表（模型选择器=账号切换） |
| `GET/PUT /api/settings` | `data/settings.json`（系统提示词/账号，供设置页用，走认证） |
| `GET /api/splash` | `face/splash_lines.json`（按北京时间时段随机） |
| `POST /api/thinking-summary` / `tool-caption` | 暂返回空（前端自带降级），后续可接便宜模型 |

## 部署

```bash
# 1. 配置认证（强烈建议）
export FACE_PASSWORD='你的登录密码'
export FACE_SECRET='一串随机字符串，用来签 token'
# 或写进 data/settings.json 的 facePassword / faceSecret 字段

# 2. 启动（face 随网关一起起，同一个端口 3800）
cd chat-api && node server.mjs
```

两个变量都不配时 face 处于**无认证开放模式**（启动日志会警告），
只适用于外层已有 Cloudflare Access / nginx basic auth 的部署。

### Cloudflare Tunnel（推荐，无需 nginx）

在 Cloudflare Tunnel 的 Public Hostnames 里加一条子域名路由，
Service 指向 `http://localhost:3800`，就这一步。

老端点（`/conversations`、`/settings`、`/gateway/*`）有内置门锁：
配置了 face 认证后，带反代转发头（cf-connecting-ip / x-forwarded-for /
x-real-ip）的公网流量访问这些路由需要 face 的 Bearer token；
本机 cron 和网关自己的回环调用不带这些头，照常放行。
face 未配置密码时门锁不生效（整体开放模式，仅限有外层防护的部署）。

如果走 nginx 反代，SSE 需要 `proxy_buffering off`。

## 已知边界（第一刀的刻度）

- 附件：第一张图片走网关的原生 image 通道；其余文件以文字注记进正文
  （原件都在 `uploads/` 里，不丢）。
- `thinking-summary` / `tool-caption` 是空实现，思考摘要显示原文预览。
- face 的设置抽屉里还没有系统提示词/账号/记忆的编辑页（后端 `/api/settings`
  已就绪，下一刀在侧边栏加入口）。
- 原项目的消息分支（branch_count/恢复分支）简化为线性 edit/retry：
  编辑即截断重写，与网关的 edit_at 语义一致。
