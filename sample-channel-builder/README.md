# Claude Code Channel — Webhook Server

一個基於 [MCP](https://modelcontextprotocol.io/) 的 Claude Code Channel server，透過 HTTP webhook 讓外部系統（CI/CD、監控告警、聊天平台）與 Claude Code 工作階段雙向溝通。

## 架構

```
外部系統
  │  HTTP POST  (入站)
  ▼
webhook.ts  (本機 :8788)
  │  stdio MCP  (雙向)
  ▼
Claude Code
  │  reply tool  (出站)
  ▼
webhook.ts  →  SSE /events  →  curl / 外部系統
```

Claude Code 會將此 server 作為子程序啟動，透過 stdio 溝通。你**不需要**自己執行 server。

## 前置需求

- [Bun](https://bun.sh/) 執行時
- [Claude Code](https://code.claude.com/) v2.1.80 以上（需以 claude.ai 帳戶登入）

## 安裝

```bash
cd slack-channel-builder
bun install
```

## 使用方式

### 1. 啟動 Claude Code（指定 development-channels 旗標）

```bash
# 在此目錄下，.mcp.json 中的相對路徑會自動找到 webhook.ts
claude --dangerously-load-development-channels server:webhook
```

Claude Code 啟動時會自動生成 `webhook.ts` 子程序，HTTP server 隨之在 `:8788` 啟動。

### 2. 監聽 Claude 的回覆（SSE）

```bash
# 第二個終端機
curl -N localhost:8788/events
```

### 3. 傳送訊息給 Claude

```bash
# 第三個終端機
# X-Sender 標頭必須在 ALLOWED_SENDERS 允許清單中（預設為 "dev"）
curl -d "請列出當前目錄的檔案" -H "X-Sender: dev" localhost:8788
```

### 4. 遠端批准工具使用

當 Claude 需要執行工具（如 Bash、Write）時，`/events` 串流會收到提示，包含 5 字母的 request ID：

```bash
# 批准
curl -d "yes abcde" -H "X-Sender: dev" localhost:8788

# 拒絕
curl -d "no abcde" -H "X-Sender: dev" localhost:8788
```

## 環境變數

| 變數              | 預設值 | 說明                                               |
| ----------------- | ------ | -------------------------------------------------- |
| `PORT`            | `8788` | HTTP 監聽埠                                        |
| `ALLOWED_SENDERS` | `dev`  | 允許的 X-Sender 值，逗號分隔（例：`alice,bot,ci`） |

使用範例：

```bash
PORT=9000 ALLOWED_SENDERS=alice,bob claude --dangerously-load-development-channels server:webhook
```

## Channel 行為

| 功能           | 說明                                                       |
| -------------- | ---------------------------------------------------------- |
| **單向接收**   | `POST /` 任意文字 → Claude 讀取並採取行動                  |
| **雙向回覆**   | Claude 透過 `reply` 工具回傳，訊息顯示於 `GET /events`     |
| **寄件者驗證** | 未在 `ALLOWED_SENDERS` 中的請求返回 403，防止提示注入      |
| **權限中繼**   | 工具批准提示即時推送到 `/events`，可遠端回覆 `yes/no <id>` |

## 安全說明

- Server 僅綁定 `127.0.0.1`，外部機器無法直接存取
- 寄件者驗證（`ALLOWED_SENDERS`）防止任意人員注入提示
- 正式環境請從環境變數或加密設定檔讀取允許清單，勿寫死在程式碼中
- 僅在信任的 channel 上啟用 `claude/channel/permission`（權限中繼），因為允許清單成員可批准工具執行

## 檔案結構

```
slack-channel-builder/
├── webhook.ts      # Channel server 主程式
├── .mcp.json       # Claude Code MCP 設定（claude code 自動讀取）
├── package.json    # 相依套件
└── README.md       # 此文件
```

## 延伸閱讀

- [Channels 參考文件](https://code.claude.com/docs/zh-TW/channels-reference)
- [官方 Channel 範例（Telegram/Discord/fakechat）](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins)
- [MCP 協議文件](https://modelcontextprotocol.io/)
