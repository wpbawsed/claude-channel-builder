# Claude Code Channel — Notion (Polling)

一個基於 [MCP](https://modelcontextprotocol.io/) 的 Claude Code Channel server，透過 Notion API polling 將 Notion database 中的 task 卡片自動轉發給 Claude Code 處理，並將結果寫回 Notion page。

## 架構

```
Notion Database
    │  status = Ready (手動觸發)
    │  polling (每 POLL_INTERVAL_MS 毫秒)
    ▼
notion-channel.ts  (MCP Server, stdio)
    │  status → In Progress
    │  轉發 task 內容
    ▼
Claude Code
    │  執行任務
    │  reply tool
    ▼
notion-channel.ts  →  notion.pages.update  →  Notion page
                       status → Done / Failed
                       agent_log → 執行結果
```

Claude Code 會將此 server 作為子程序啟動，透過 stdio 溝通。你**不需要**自己執行 server。

## 前置需求

- [Bun](https://bun.sh/) 執行時
- [Claude Code](https://code.claude.com/) v2.1.80 以上（需以 claude.ai 帳戶登入）
- Notion Integration Token 與目標 Database

## Notion 設定

### 1. 建立 Notion Integration

前往 [https://www.notion.so/my-integrations](https://www.notion.so/my-integrations)，建立一個新的 Integration。

記下 **Internal Integration Token**（`secret_...`）。

### 2. 建立或使用現有 Database

Database 需包含以下 properties：

| Property      | Type   | 說明                                            |
| ------------- | ------ | ----------------------------------------------- |
| `title`       | Title  | 任務名稱（必填）                                |
| `type`        | Select | 任務類型（例：`repo-init`、`general`）          |
| `template`    | Select | 對應 template 名稱（可選）                      |
| `description` | Text   | 任務說明，傳給 Claude                           |
| `status`      | Status | `Backlog → Ready → In Progress → Done → Failed` |
| `agent_log`   | Text   | Claude 執行結果（自動填入）                     |

### 3. 連接 Integration 到 Database

在 Notion Database 頁面右上角 → `...` → **Connections** → 搜尋並加入你的 Integration。

### 4. 取得 Database ID

複製 Database 頁面 URL，其中 `notion.so/` 後的 32 字元即為 Database ID：

```
https://www.notion.so/your-workspace/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx?v=...
                                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                                     這是 Database ID
```

## 安裝

```bash
cd notion-channel-builder
bun install
```

## 使用方式

### 啟動 Claude Code（附帶 Notion channel）

```bash
cd notion-channel-builder

NOTION_API_KEY=secret_... \
NOTION_DATABASE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
claude --dangerously-load-development-channels server:notion
```

### 觸發任務

在 Notion Database 中，將任意 task 的 **status 改為 `Ready`**。

Server 會在下次 polling 時偵測到，自動：

1. 將 status 改為 `In Progress`
2. 將任務內容傳給 Claude 執行
3. 執行完成後更新 status 為 `Done`（或 `Failed`），並寫入 `agent_log`

### Status 流轉

```
Backlog  →  Ready  →  In Progress  →  Done
                                  →  Failed
           ↑
        手動觸發
```

## 環境變數

| 變數                 | 必填 | 說明                                        |
| -------------------- | ---- | ------------------------------------------- |
| `NOTION_API_KEY`     | ✅   | Notion Integration Token（`secret_...`）    |
| `NOTION_DATABASE_ID` | ✅   | 目標 Database ID（32 字元）                 |
| `POLL_INTERVAL_MS`   | ❌   | Polling 間隔（毫秒），預設 `30000`（30 秒） |

## Channel 行為

| 功能             | 說明                                                        |
| ---------------- | ----------------------------------------------------------- |
| **觸發方式**     | Notion page status 設為 `Ready`                             |
| **對話範圍**     | 每個 Notion page = 一次任務執行                             |
| **chat_id 格式** | Notion page ID（UUID，例：`abc12345-...`）                  |
| **回覆方式**     | 更新 page 的 `status` + `agent_log` properties              |
| **多任務處理**   | 依序執行（sequential），避免 race condition                 |
| **權限中繼**     | 未啟用。建議在受控環境中使用，搭配 Claude Code 手動批准工具 |

## 安全說明

- 此 server 不啟用 `claude/channel/permission`（Notion comment polling 延遲過高）
- 建議在本機或受控 CI 環境中使用
- `NOTION_API_KEY` 請勿寫死在程式碼中，從環境變數讀取

## 与既有 notion-poller.ts 的差異

|             | notion-poller.ts（舊）                | notion-channel.ts（新）                  |
| ----------- | ------------------------------------- | ---------------------------------------- |
| 執行模式    | spawn `claude -p`（非互動式）         | MCP Channel Server（互動式）             |
| Claude 版本 | 每次任務 spawn 新的 claude            | 同一個 Claude Code session               |
| 回覆方式    | Claude 透過 Notion MCP 直接更新       | Claude 透過 `reply` tool 更新            |
| 工具批准    | `--dangerously-skip-permissions` 跳過 | Claude Code session 中手動或透過環境設定 |
| 適用場景    | 自動化 CI/CD（無人看管）              | 互動式任務（需要人工判斷）               |

## 檔案結構

```
notion-channel-builder/
├── notion-channel.ts  # Channel server 主程式（新）
├── notion-poller.ts   # 舊版 spawn 模式（已廢棄，保留參考）
├── spec.md            # 舊版設計文件（已廢棄，保留參考）
├── .mcp.json          # Claude Code MCP 設定（自動讀取）
├── .claude/
│   └── settings.local.json  # 啟用 MCP server
├── package.json       # 相依套件
└── README.md          # 此文件
```

## 延伸閱讀

- [Channels 參考文件](https://code.claude.com/docs/zh-TW/channels-reference)
- [Notion API 文件](https://developers.notion.com/)
- [@notionhq/client NPM](https://www.npmjs.com/package/@notionhq/client)
- [MCP 協議文件](https://modelcontextprotocol.io/)
