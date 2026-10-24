# webaiapi（命令名：`webaiapi`）

**中文** | [English](https://github.com/amble311/webaiapi/blob/main/README.en.md)

把 AI 聊天网页（**ChatGLM / 智谱清言**、**DeepSeek**、**ChatGPT**）包装成 **OpenAI 兼容 API**。
纯浏览器自动化（Playwright Firefox），**不需要 API Key、不需要逆向签名**——你只要在浏览器里登录一次。

用它可以在任何支持 OpenAI 协议的客户端（CodeBuddy、Trae、Cursor、各类 SDK）里，
直接使用你的网页端账号额度。

---
## 快速上手
```bash
npm i -g webaiapi
webaiapi login # 按照提示登录平台账号，建议两个号以上
```
```bash
webaiapi start
```
在agent中的调用配置如下：
模型地址：http://0.0.0.0:8631/v1
模型ID: mix, chatglm, deepseek，chatgpt。 #mix为自动选择可用平台，其余为指定使用该平台的模型。
apikey: 随便填，不校验
上下文输入：64K（65536）
上下文输出：64K（65536）
上述设置如需修改，请在.env文件中修改。


## 安装

```bash
npm i -g webaiapi
```

浏览器（Playwright Firefox，约 80MB）**会自动下载，不需要手动操作**：

- 安装时会尝试下载一次（`postinstall`）；
- ⚠️ npm 11+ 默认**拦截安装脚本**，所以**首次运行 `webaiapi start` / `webaiapi login` / `webaiapi doctor`
  时会再检查一次并自动补装**；
- 只有在网络策略拦住、或你显式设了 `WEBAIAPI_SKIP_BROWSER_INSTALL` / `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`
  时，才需要手动补一条：

```bash
npx playwright install firefox
```

然后登录并捕获凭证（会打开可见的浏览器，你手动登录）：

```bash
webaiapi login
```

不加参数会**交互式**让你选平台（`↑/↓` + 回车，或直接敲编号），随后选「添加账号 / 重新登录」。
想跳过菜单就直接给平台名：`webaiapi login chatglm`。

> 不确定环境有没有问题？先跑一次自检：

```bash
webaiapi doctor
```

它会检查 Node 版本、Firefox 二进制、凭证、端口，并给出可复制的修复命令。

> **跳过自动下载**：设 `WEBAIAPI_SKIP_BROWSER_INSTALL=1`（或用 Playwright 自己的
> `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`）。CI 里常用。

## 启动

```bash
webaiapi start
```

服务默认监听 `http://0.0.0.0:8631`，OpenAI 兼容端点在 `/v1`：

```bash
# 健康检查
curl -s http://localhost:8631/v1/health

# 对话（非流式）
curl -s -X POST http://localhost:8631/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"chatglm","messages":[{"role":"user","content":"你好"}]}'

# 流式
curl -N -X POST http://localhost:8631/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"chatglm","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

在客户端里配置基址 `http://localhost:8631/v1`，API Key 随便填（未启用校验时），
模型名填 `chatglm` 或 `mix`。

## 命令

| 命令 | 说明 |
|---|---|
| `webaiapi start` | 启动服务（前台运行，Ctrl-C 退出） |
| `webaiapi doctor` | 自检：Node / Firefox / 凭证 / 端口 |
| `webaiapi stop` | 停止后台启动的服务（读 `start` 写的 PID 文件；`--force` 强杀） |
| `webaiapi model` | **可用模型 id + 配置建议**（配客户端前先看它；`--json` 输出机器可读） |
| `webaiapi status` | 运行状态：账号、角色、辅助通道、请求池 |
| `webaiapi accounts` | 只看账号与角色（判断「多账号有没有生效」的权威视图） |
| `webaiapi health` | 各平台登录状态 |
| `webaiapi login [<platform>] [--account <id>]` | 登录并捕获凭证（不给参数则交互式选择平台/账号） |
| `webaiapi logout [<platform>] [--account <id>]` | 删除某账号的凭证（不给参数则交互式选择） |

脚本 / CI 里用非交互写法（`--yes` 跳过确认）：

```bash
webaiapi login chatglm --account acc2 --yes
webaiapi logout chatglm --account acc2 --yes
```

## 模型

| 模型名 | 说明 |
|---|---|
| `mix` | 自动按平台顺序故障转移（chatglm → deepseek → chatgpt） |
| `chatglm` | 平台名模型，只跨账号、不跨平台 |
| `deepseek` | 同上（DeepSeek 网页版） |
| `chatgpt` | 同上（ChatGPT 网页版）⚠️ 见下方网络要求 |
| `glm-4` / `glm-3` | ChatGLM 的具体模型别名 |

> ⚠️ **`chatgpt` 需要能正常访问 `chatgpt.com` 的网络环境**（一般要代理/VPN）：
> - **必须显式配置代理**：Playwright **不读** `HTTP_PROXY`/`HTTPS_PROXY` 环境变量，
>   请在 `.env` 里设 `BROWSER_PROXY=http://127.0.0.1:7890`（留空则自动取环境变量）；
>   不配代理时页面能打开但 `backend-api` 全失败 → 表现为「消息发出去了但永远没有回复」；
> - 浏览器的出口必须能打开 `chatgpt.com`（Cloudflare / 风控对机房 IP 很敏感）；
> - 登录用 **Firefox**（`LOGIN_BROWSER=firefox`，默认）—— 实测 Chromium/Playwright 过不了 Cloudflare 真人验证 ✗；
> - **首次请求要等页面水合**（约 30~90s，算在 `REQUEST_TIMEOUT` 里），之后同一进程内会快；
> - 目前是**整段返回**（不逐字流式），先保证内容完整。

## 多账号（可选，但推荐）

加第二个账号后，服务会启用**辅助通道**：压缩历史/工具调用转换等辅助任务
会在另一个账号的独立页面上跑，与你的主对话**真正并行**，不再排队。

再跑一次 `webaiapi login` 选「添加新账号」即可，**账号名会自动从登录身份派生**
（用户名 → uid），不用自己想名字：

```bash
webaiapi login
#   要登录哪个平台？        → ChatGLM (智谱)
#   这次要做什么？          → ➕ 添加新账号
#   ...手动登录另一个账号...
#   ✔ 凭证已保存   账号: alice
```

选错了随时可以退：二级菜单里有 `← 返回上一步（重新选平台）`，
平台菜单里有 `✗ 退出`；任何时候按 `Esc` / `Ctrl+C` 也会取消。
（用 `webaiapi login <platform>` 明确指定平台时，菜单里给的是 `✗ 取消` —— 没有上一步可回。）

> ⚠️ **两个账号必须是不同的人。** 系统浏览器很可能还留着上一个账号的登录态，
> 抓到同一个人时服务会以为「有两个账号」并启用并行，结果两边打同一个账号，
> 立刻收到「请等待其他对话生成完毕」。所以服务会**校验身份与 Cookie**：
> - 抓到的和已有账号是同一个登录态 → 提示你选择「更新该账号 / 另存为新账号 / 取消」
> - 非交互时（脚本）默认**更新原账号**，绝不悄悄多出一个重名账号

用 `webaiapi accounts` 核对身份与角色分配。主/辅角色**启动时随机分配**以摊平额度消耗；
需要钉死时用环境变量：

```bash
CHATGLM_MAIN_ACCOUNT=acc2 webaiapi start
```

## 配置

放在项目目录的 `.env`，或直接用环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `API_HOST` / `API_PORT` | `0.0.0.0` / `8631` | 监听地址与端口 |
| `API_PREFIX` | `/v1` | 路由前缀 |
| `REQUEST_TIMEOUT` | `300` | 请求超时（秒） |
| `RATE_LIMIT_ENABLED` | `false` | 是否限流 |
| `RATE_LIMIT_PER_MINUTE` | `60` | 每客户端每分钟请求数 |
| `API_KEYS` | 空 | 逗号分隔的密钥列表 |
| `API_KEY_REQUIRED` | `false` | 是否**强制**校验（配了密钥才生效） |
| `DEBUG_LOGS` | `false` | 是否写 `~/.ai-api/logs/debug_*.log` |
| `AUTH_DIR` | `~/.ai-api/auth` | 凭证目录 |
| `LOG_DIR` | `logs` | 运行日志与 API 记录目录 |
| `CHATGLM_MAIN_ACCOUNT` | 随机 | 钉死主通道账号 |
| `BROWSER_HEADLESS` | 见实现 | `true` 时无头运行（服务器部署用） |
| `WEBAIAPI_SKIP_BROWSER_INSTALL` | — | 设 1 跳过安装期的浏览器下载 |

凭证、历史数据库、调试日志都在 `~/.ai-api/` 下。

## 常见问题

**「请求过于频繁，请稍后再试」**
多半是**未登录**（访客额度用完了）。重新登录：`webaiapi login chatglm`。

**抓到的账号不是我想登的那个**
系统浏览器里往往还留着上一个账号的登录态。先在该页面**退出登录**，再登目标账号。

**第一次对话很慢（20s+）**
首次需要启动浏览器 + 导航 + 探测登录态。之后同会话会复用页面，
准备阶段降到 0~3s。

**任务跑一半停了、文件没改**
网页端模型有时会「只写计划不调工具」。服务会自动再驱动一轮；
若仍反复出现，把任务拆小一点（例如一次只让它改一个文件）。

**怎么看到底发生了什么**
- `logs/api_requests.log` —— 请求/响应**原样记录、不做加工**，每次启动重置
- `logs/chatglm_sse_last.txt` —— 最近一轮的原始 SSE 报文（排查上游格式变化）

## 开发

```bash
npm install        # 会自动 build（package.json 的 prepare 脚本）
npm run dev        # 直接跑 tsx src/cli.ts，不用先构建
npm run typecheck
npm test           # 单测（当前 586 个）
npm run build      # 产出 dist/
```

## 致谢

本项目的浏览器自动化完全建立在 [Playwright](https://github.com/microsoft/playwright) 之上 ——
登录态捕获、页面注入、SSE 抓取与反检测这些关键环节都依赖它。

感谢 Playwright 的作者与维护者（Microsoft 及所有贡献者）：
没有这个优秀的项目，webaiapi 不可能存在。

## 许可

MIT
