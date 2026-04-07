# Claude Channel Builder

一套基於 [MCP（Model Context Protocol）](https://modelcontextprotocol.io/) 的 Claude Code Channel server 範本集，讓外部系統與 Claude Code 工作階段雙向溝通。

## 什麼是 Claude Code Channel？

Claude Code Channel 是 Claude Code 的實驗性功能，讓你透過自訂的 MCP server 接收來自外部管道（Slack、Notion、Webhook 等）的訊息，並讓 Claude 在其中自動執行任務、回覆對話。

```
外部管道（Slack / Notion / HTTP）
        │
        ▼
  Channel Server（本 repo）
  [MCP, stdio transport]
        │
        ▼
    Claude Code
        │  執行任務、回覆訊息
        ▼
  Channel Server  →  外部管道
```

## 內容

| 目錄 | 說明 |
| --- | --- |
| [`slack-channel-builder/`](./slack-channel-builder/) | 透過 Slack Socket Mode 與 Claude 雙向對話，支援 @Bot mention 及 DM |
| [`notion-channel-builder/`](./notion-channel-builder/) | Polling Notion Database，自動將 `Ready` 狀態的任務卡片轉交 Claude 執行 |
| [`sample-channel-builder/`](./sample-channel-builder/) | HTTP Webhook 範本，適合快速自訂或整合其他系統 |

## 前置需求

- [Bun](https://bun.sh/) 執行時
- [Claude Code](https://code.claude.com/) v2.1.80 以上（需以 claude.ai 帳戶登入）

## 快速開始

### Slack

```bash
cd slack-channel-builder
cp .env.example .env   # 填入 SLACK_BOT_TOKEN、SLACK_APP_TOKEN
bun install
claude --dangerously-load-development-channels server:slack
```

→ 詳細 Slack App 設定步驟請見 [slack-channel-builder/README.md](./slack-channel-builder/README.md)

### Notion

```bash
cd notion-channel-builder
cp .env.example .env   # 填入 NOTION_API_KEY、NOTION_DATABASE_ID
bun install
claude --dangerously-load-development-channels server:notion
```

→ 詳細 Notion 設定步驟請見 [notion-channel-builder/README.md](./notion-channel-builder/README.md)

### Webhook（HTTP）

```bash
cd sample-channel-builder
bun install
claude --dangerously-load-development-channels server:webhook
```

→ 詳細說明請見 [sample-channel-builder/README.md](./sample-channel-builder/README.md)

## 架構說明

每個 Channel server 都是一個標準 MCP server，透過 `stdio` transport 與 Claude Code 溝通，並宣告以下 capabilities：

| Capability | 說明 |
| --- | --- |
| `claude/channel` | 宣告為 channel，接收外部訊息 |
| `claude/channel/permission` | 選填，啟用工具批准中繼（Slack 支援） |
| `tools` (`reply`) | Claude 用此工具將回覆送回外部管道 |

## 延伸閱讀

- [Channels 參考文件](https://code.claude.com/docs/zh-TW/channels-reference)
- [MCP 協議文件](https://modelcontextprotocol.io/)
- [官方 Channel 範例（Telegram / Discord）](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins)
