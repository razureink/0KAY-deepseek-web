# 0KAY · DeepSeek 网页版 provider

把 `chat.deepseek.com` 的网页登录态接进 0KAY：用你已登录的网页版（不是 API Key）
驱动模型调用。对 Core 暴露一个 **OpenAI 兼容**的 provider。

**由 Core 以 stdio 子进程承载 —— 不监听任何端口。** 插件 manifest 声明 `provider.stdio`，
Core 启动时把它作为子进程拉起、在自有的 HTTP 端口上用 `/api/stdio-provider/<id>/…`
代理，并自动注册成 provider。

请求构造 / PoW（SHA3 WASM 求解）/ SSE 解析移植自
[cv-superding/dsh-deepseek-web-login](https://github.com/cv-superding/dsh-deepseek-web-login)（Apache-2.0，见 `NOTICE`）。

## 工作原理

```
mocr ──▶ Core: /api/stdio-provider/deepseek-web/v1/chat/completions
             │  （Core 把请求写成 JSON 行到本子进程的 stdin）
             ▼
        node src/stdio.mjs  ──▶ chat.deepseek.com 私有接口
             ├─ chat_session/create → create_pow_challenge → SHA3 WASM 求解
             └─ chat/completion（SSE）→ 解析成 OpenAI 流 → 写回 stdout
```

## manifest

```json
"provider": {
  "id": "deepseek-web",
  "name": "DeepSeek 网页版（免费）",
  "models": ["deepseek-web-chat", "deepseek-web-reasoner"],
  "default_model": "deepseek-web-chat",
  "route": "/v1",
  "stdio": ["node", "src/stdio.mjs"]
}
```

Core 读取已安装包的 `provider` 块，拉起子进程，并把 provider 的 `base_url` 指向
`http://127.0.0.1:<core-http-port>/api/stdio-provider/deepseek-web/v1`。

## 配置

设置页（**设置 → DeepSeek 网页版**）由插件自带的**自定义 WebUI 面板**提供（`ui/panel.js` + `patches/deepseek-web.patch`，不是默认的字段表）：

| 设置 | 默认 | 说明 |
|---|---|---|
| `token` | 空 | Bearer Token（F12 从 chat.deepseek.com 请求里取） |
| `auth_file` | 空 | 凭据文件路径（默认 `~/.dsh/web-login/deepseek-auth.json`） |
| `accounts` | `[]` | 账号库（JSON 数组 `{id,label,token,...}`），由面板「账号库」维护 |
| `active_account` | 空 | 当前账号 id；所有请求用它，未设则用 `token`/`auth_file` |
| `default_model` | `deepseek-web-chat` | 未指定模型时使用 |
| `max_prompt_chars` | `400000` | prompt 字符上限（中段截断） |
| `min/max_request_interval_ms` | `2000/4000` | 两次调用的随机间隔区间（从上次结束算起） |
| `allow_concurrent` | `false` | 同账号并发会触发临时封禁，默认串行 |
| `idle_timeout_ms` | `120000` | SSE 空闲超时 |
| `auto_continue` / `max_continuations` | `true` / `2` | 句中被截断时自动续写 |
| `session_cleanup` | `deferred` | `deferred`/`immediate`/`keep`（keep=不删临时会话） |
| `probe_interval_ms` | `1800000` | 只读探活间隔，零额度，0=关闭 |
| `max_ref_images` | `24` | 一次请求随附的图片上限（图片经 `file/upload_file` 上传后以 `ref_file_ids` 引用） |
| `context_mode` | `full` | `full`=每轮回发全量；`chained`=只发增量（需请求带 `user`/`session_id`） |

面板还带一个**连通性测试**按钮（调 `/api/stdio-provider/deepseek-web/v1/probe`，只读零额度）。

环境变量（无设置时兜底）：`DEEPSEEK_WEB_TOKEN`、`DEEPSEEK_WEB_AUTH_FILE`。

## 模型

- `deepseek-web-chat` — 快速模式（thinking 关）
- `deepseek-web-reasoner` — 快速模式（thinking 开，推理流走 `reasoning_content`）

## 调试

```bash
node src/stdio.mjs                       # 由 Core 拉起时用的模式（stdin/stdout 上跑 JSON 行协议）
node src/server.mjs                      # 本地 HTTP 模式（可选，会监听 127.0.0.1:8792）
printf '{"id":"t","method":"GET","url":"/v1/models"}\n' | node src/stdio.mjs
node --test test/
```

已知限制：网页端无原生 function calling（`tools` 目前只按文本拼进 prompt）；`temperature`/`max_tokens` 等字段网页端忽略；usage 为估算值。安装插件后需**重启 Core** 才会拉起子进程。
