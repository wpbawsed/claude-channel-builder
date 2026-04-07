# Claude Code Channel — Slack (Socket Mode)

一個基於 [MCP](https://modelcontextprotocol.io/) 的 Claude Code Channel server，透過 Slack Socket Mode 讓 Slack workspace 與 Claude Code 工作階段雙向即時溝通。

## 架構

```
Slack Workspace
    │  @Bot 觸發 (app_mention)
    │  Socket Mode WebSocket
    ▼
slack-channel.ts  (MCP Server, stdio)
    │
    ▼
Claude Code
    │  reply tool
    ▼
slack-channel.ts  →  chat.postMessage  →  Slack thread
```

Claude Code 會將此 server 作為子程序啟動，透過 stdio 溝通。你**不需要**自己執行 server。

## 前置需求

- [Bun](https://bun.sh/) 執行時
- [Claude Code](https://code.claude.com/) v2.1.80 以上（需以 claude.ai 帳戶登入）
- 一個 Slack App（見下方設定步驟）

## 建立 Slack App

### 1. 前往 Slack API Console

打開 [https://api.slack.com/apps](https://api.slack.com/apps)，點選 **Create New App** → **From scratch**。

### 2. 啟用 Socket Mode

在 **Settings → Socket Mode** 中開啟 **Enable Socket Mode**。

生成一個 App-Level Token（Scope: `connections:write`），記下 `xapp-...` token。

### 3. 訂閱事件

在 **Event Subscriptions → Subscribe to bot events** 中新增：

| Event         | 說明                          |
| ------------- | ----------------------------- |
| `app_mention` | 使用者在 channel 中 @Bot 觸發 |
| `message.im`  | 使用者直接傳 DM 給 Bot 觸發   |

### 4. 設定 Bot Token Scopes

在 **OAuth & Permissions → Scopes → Bot Token Scopes** 新增：

| Scope               | 說明                                             |
| ------------------- | ------------------------------------------------ |
| `app_mentions:read` | 讀取 channel 中的 @mention 事件                  |
| `chat:write`        | 發送訊息到 channel 或 DM                         |
| `reactions:write`   | 加入 / 移除 reaction（執行中展示“思考中”狀態）   |
| `im:history`        | 讀取 DM 訊息（DM 支援必填）                      |
| `channels:history`  | 讀取 public channel 歷史（permission relay 用）  |
| `groups:history`    | 讀取 private channel 歷史（permission relay 用） |

### 5. 安裝 App

在 **OAuth & Permissions** 中點選 **Install to Workspace**，完成後記下 `xoxb-...` Bot User OAuth Token。

### 6. 邀請 Bot 到 Channel

在 Slack 中 `/invite @YourBotName` 到你要使用的 channel。

## 安裝

```bash
cd slack-channel-builder
bun install
```

## 使用方式

### 啟動 Claude Code（附帶 Slack channel）

```bash
cd slack-channel-builder

SLACK_BOT_TOKEN=xoxb-... \
SLACK_APP_TOKEN=xapp-... \
claude --dangerously-load-development-channels server:slack
```

Claude Code 啟動時會自動生成 `slack-channel.ts` 子程序，Slack Socket Mode 連線隨之建立。

### 與 Claude 互動

在 Slack 中 @Bot 發送訊息：

```
@YourBot 幫我列出今天有哪些 PR 需要 review
```

Claude 的回覆會出現在同一則訊息的 thread 中。

### 遠端批准工具使用

當 Claude 需要執行工具（如 Bash、Write）時，thread 中會收到提示：

```
⚠️ Claude 想要執行 Bash：列出目錄檔案
> {"command": "ls -la"}

請回覆 `yes abcde` 允許，或 `no abcde` 拒絕。
```

在同一 thread 中回覆：

```
yes abcde
```

## 環境變數

| 變數                   | 必填 | 說明                                                                                     |
| ---------------------- | ---- | ---------------------------------------------------------------------------------------- |
| `SLACK_BOT_TOKEN`      | ✅   | Slack Bot User OAuth Token（`xoxb-...`）                                                 |
| `SLACK_APP_TOKEN`      | ✅   | Slack App-Level Token，Socket Mode 用（`xapp-...`）                                      |
| `SLACK_CHANNEL_FILTER` | ❌   | 限定監聽的 channel ID，逗號分隔（例：`C01234567,C09876543`）。空值 = 監聽所有頻道        |
| `ALLOWED_USER_IDS`     | ❌   | 使用者白名單，Slack user ID 逗號分隔（例：`U01ABC123,U02DEF456`）。空值 = 允許所有使用者 |

## Channel 行為

| 功能             | 說明                                                                      |
| ---------------- | ------------------------------------------------------------------------- |
| **觸發方式**     | Channel：`@Bot` mention（`app_mention`）；DM：直接傳訊息（`message.im`）  |
| **對話範圍**     | 每個 Slack thread = 一次 Claude 對話                                      |
| **chat_id 格式** | `channel_id:thread_ts`（例：`C01234567:1234567890.123456`）               |
| **回覆位置**     | 同一 thread（DM 也會建立 thread）                                         |
| **權限中繼**     | 工具批准提示出現在 thread，由終端機器人在終端確認（不需在 Slack 回復）    |
| **執行狀態**     | Claude 處理中，原始訊息會顯示 ⏳ reaction；回覆後自動移除                 |
| **頻道過濾**     | 透過 `SLACK_CHANNEL_FILTER` 限制監聽範圍（僅限 channel，不影響 DM）       |
| **使用者白名單** | 透過 `ALLOWED_USER_IDS` 限制能使用 Bot 的使用者（未授權者將收到拒絕訊息） |

## 安全說明

- Socket Mode 透過 WebSocket 連線，不需要 public URL
- Channel 只回應 `@Bot` mention，DM 只回應真人使用者（自動過濾 bot 自身的訊息）
- `ALLOWED_USER_IDS` 可限制只有特定使用者能下指令（未授權者將獲得拒絕訊息，不會轉發給 Claude）
- `SLACK_CHANNEL_FILTER` 可限制 Bot 只回應特定 channel，防止跟頻道濫用（不影響 DM）
- 建議在正式環境中同時設定 `SLACK_CHANNEL_FILTER` 和 `ALLOWED_USER_IDS`

## 檔案結構

```
slack-channel-builder/
├── slack-channel.ts   # Channel server 主程式
├── .mcp.json          # Claude Code MCP 設定（自動讀取）
├── .claude/
│   └── settings.local.json  # 啟用 MCP server
├── package.json       # 相依套件
└── README.md          # 此文件
```

## 延伸閱讀

- [Channels 參考文件](https://code.claude.com/docs/zh-TW/channels-reference)
- [Slack Socket Mode 文件](https://api.slack.com/apis/connections/socket)
- [Slack Bolt for JS 文件](https://github.com/slackapi/bolt-js)
- [MCP 協議文件](https://modelcontextprotocol.io/)
