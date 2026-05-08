# Claude Code Channel — Jira (Webhook)

一個基於 [MCP](https://modelcontextprotocol.io/) 的 Claude Code Channel server，透過 Jira Webhook 把 issue 即時送進 Claude Code 執行，並把結果回寫到 Jira comment。

## 架構

```
Jira Project
   │  Webhook (issue created / updated)
   ▼
jira-channel.ts  (HTTP + MCP Server)
   │
   ▼
Claude Code
   │  reply tool
   ▼
Jira Issue Comment + Transition
```

## 功能

- 即時觸發：由 Jira 主動 POST webhook 到本服務
- 任務派送：每個 issue 以 `<channel source="jira" chat_id="ISSUE_KEY">` 送給 Claude
- 回寫結果：Claude 用 `reply` 工具回填 comment
- 狀態流轉：可依 `reply(status)` 自動轉 `Done` 或 `Failed`

## 前置需求

- [Bun](https://bun.sh/) 執行時
- [Claude Code](https://code.claude.com/) v2.1.80 以上
- Jira Cloud 帳號與 API Token
- 一個可被 Jira 存取的 webhook URL（例如 ngrok 或 cloudflared）

## 安裝

```bash
cd jira-channel-builder
bun install
cp .env.example .env
```

## 啟動

```bash
cd jira-channel-builder
set -a
source .env
set +a
claude --dangerously-load-development-channels server:jira
```

預設 webhook 入口：

- `POST http://127.0.0.1:8789/webhook/jira`
- 健康檢查：`GET http://127.0.0.1:8789/health`

如果 Jira 在雲端，請把本機端口透過 tunnel 暴露，例如 `https://xxxx.ngrok.app/webhook/jira`。

## Jira 端怎麼操作（Webhook 設定）

1. 準備外部可達 URL
   - 本機起服務後，用 ngrok/cloudflared 建 tunnel
   - 得到公開網址，例如 `https://abcd.ngrok.app`
2. 建立 Jira Webhook
   - Jira 管理頁面進入：System -> Webhooks -> Create a WebHook
   - URL 填：`https://abcd.ngrok.app/webhook/jira?token=你的WEBHOOK_SECRET`
   - 事件建議勾：Issue created、Issue updated
3. 用 issue 驗證
   - 新建或更新一張符合條件的 issue
   - 觀察服務端是否收到並轉發給 Claude
4. 權限確認
   - `JIRA_EMAIL` 對應帳號需要 Browse、Add Comment、Transition Issues 權限

## 環境變數

| 變數                   | 必填 | 說明                                                               |
| ---------------------- | ---- | ------------------------------------------------------------------ |
| `JIRA_BASE_URL`        | ✅   | Jira Cloud 網址，例如 `https://your-company.atlassian.net`         |
| `JIRA_EMAIL`           | ✅   | Jira 帳號 Email                                                    |
| `JIRA_API_TOKEN`       | ✅   | Jira API Token                                                     |
| `PORT`                 | ❌   | Webhook server 埠（預設 `8789`）                                   |
| `WEBHOOK_PATH`         | ❌   | Webhook 路徑（預設 `/webhook/jira`）                               |
| `WEBHOOK_SECRET`       | ❌   | Webhook 驗證 token（可放 header 或 query）                         |
| `JIRA_ALLOWED_EVENTS`  | ❌   | 允許事件，逗號分隔（預設 `jira:issue_created,jira:issue_updated`） |
| `ALLOWED_PROJECT_KEYS` | ❌   | 允許專案 key，逗號分隔（空值表示不限制）                           |
| `REQUIRED_STATUS`      | ❌   | 僅處理指定狀態（空值表示不限制）                                   |
| `CLAIM_STATUS`         | ❌   | webhook 收到後先轉到此狀態（預設 `In Progress`）                   |
| `DONE_STATUS`          | ❌   | `reply(status=Done)` 要轉到的狀態（預設 `Done`）                   |
| `FAILED_STATUS`        | ❌   | `reply(status=Failed)` 要轉到的狀態（預設 `To Do`）                |

## reply 工具規格

`reply` 參數：

- `chat_id`: Jira issue key（例如 `DEMO-123`）
- `text`: 要寫入 issue comment 的內容
- `status`（可選）:
  - `Done`: 回寫 comment 後轉 `DONE_STATUS`
  - `Failed`: 回寫 comment 後轉 `FAILED_STATUS`
  - `CommentOnly`: 只寫 comment，不轉狀態

## 常見問題

1. Jira webhook 打不到本機
   - 需要公開 URL（ngrok/cloudflared）或部署到可公開存取的主機
2. 401 Unauthorized
   - 檢查 `JIRA_EMAIL` 與 `JIRA_API_TOKEN` 是否同一帳號
3. 找不到 Transition
   - `CLAIM_STATUS` / `DONE_STATUS` / `FAILED_STATUS` 名稱需和專案 workflow 可用 transition 名稱一致

## 檔案結構

```
jira-channel-builder/
├── jira-channel.ts
├── .env.example
├── .mcp.json
├── .claude/settings.local.json
├── package.json
└── README.md
```
