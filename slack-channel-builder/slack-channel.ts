#!/usr/bin/env bun
/**
 * Claude Code Channel Server — Slack (Socket Mode)
 *
 * 透過 stdio 連線到 Claude Code，並透過 Slack Socket Mode 建立雙向通訊：
 *   - 監聽 app_mention 事件（@Bot 觸發）→ 轉發給 Claude
 *   - Claude 透過 reply tool 回覆 → 發送到 Slack thread
 *
 * 使用方式（需要兩個終端機）：
 *   1. cd slack-channel-builder
 *      SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... \
 *      claude --dangerously-load-development-channels server:slack
 *   2. 在 Slack 中 @Bot 發送訊息，即可與 Claude 互動
 *
 * 批准工具權限：
 *   在同一則 Slack thread 中回覆 "yes <id>" 或 "no <id>"
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { App } from "@slack/bolt";
import { z } from "zod";

// ── 設定 ───────────────────────────────────────────────────────────────
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
/**
 * SLACK_CHANNEL_FILTER: 逗號分隔的 channel ID 清單
 * 空值或未設定 = 監聽所有頻道
 */
const SLACK_CHANNEL_FILTER: Set<string> | null = process.env
  .SLACK_CHANNEL_FILTER
  ? new Set(
      process.env.SLACK_CHANNEL_FILTER.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
  : null;

/**
 * ALLOWED_USER_IDS: 逗號分隔的 Slack user ID 白名單
 * 空值或未設定 = 允許所有使用者
 * 範例：ALLOWED_USER_IDS=U01ABC123,U02DEF456
 */
const ALLOWED_USER_IDS: Set<string> | null = process.env.ALLOWED_USER_IDS
  ? new Set(
      process.env.ALLOWED_USER_IDS.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
  : null;

if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
  console.error(
    "[slack-channel] Missing required env vars: SLACK_BOT_TOKEN, SLACK_APP_TOKEN",
  );
  process.exit(1);
}

// ── Slack Bolt App ────────────────────────────────────────────────────
const slackApp = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
});

// 記錄 bot 自身的 user ID（用於過濾 bot 自己的訊息）
let botUserId: string | undefined;

// 追蹤原始訊息位置（用於移除「思考中」reaction）
const pendingReactions = new Map<string, { channel: string; ts: string }>();

// ── MCP Server（Claude Code Channel）─────────────────────────────────
/**
 * chat_id 格式：`<channel_id>:<thread_ts>`
 * - channel_id: Slack channel ID（例：C01234567）
 * - thread_ts:  訊息的 thread parent timestamp（例：1234567890.123456）
 *              若訊息本身不在 thread 中，使用訊息自身的 ts 作為 thread parent
 */
const mcp = new Server(
  { name: "slack", version: "0.1.0" },
  {
    capabilities: {
      experimental: {
        // 告訴 Claude Code 這是一個 channel
        "claude/channel": {},
        // 啟用遠端權限中繼（透過 Slack thread 的 yes/no 回覆）
        "claude/channel/permission": {},
      },
      tools: {},
    },
    instructions:
      'Messages arrive as <channel source="slack" chat_id="CHANNEL_ID:THREAD_TS">. ' +
      "The chat_id format is <channel_id>:<thread_ts>. " +
      "Always reply using the reply tool with the exact chat_id from the incoming tag. " +
      "Keep replies concise and use plain text (no Markdown headers, minimal formatting).",
  },
);

// ── reply tool：Claude 用此工具將訊息回傳到 Slack thread ──────────────
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a message back to the Slack thread",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: {
            type: "string",
            description:
              'Chat identifier from the <channel> tag, format: "channel_id:thread_ts"',
          },
          text: {
            type: "string",
            description: "The reply message to send to Slack",
          },
        },
        required: ["chat_id", "text"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "reply") {
    const { chat_id, text } = req.params.arguments as {
      chat_id: string;
      text: string;
    };

    // 解析 chat_id → channel_id + thread_ts
    const colonIdx = chat_id.indexOf(":");
    if (colonIdx === -1) {
      throw new Error(
        `Invalid chat_id format: "${chat_id}". Expected "channel_id:thread_ts"`,
      );
    }
    const channel = chat_id.slice(0, colonIdx);
    const thread_ts = chat_id.slice(colonIdx + 1);

    // 移除「思考中」reaction（在回覆前先移除，讓使用者感受到狀態切換）
    const pending = pendingReactions.get(chat_id);
    if (pending) {
      await slackApp.client.reactions
        .remove({
          channel: pending.channel,
          name: "hourglass_flowing_sand",
          timestamp: pending.ts,
        })
        .catch((err) =>
          console.error(
            "[slack-channel] reactions.remove failed:",
            err?.data?.error ?? err,
          ),
        );
      pendingReactions.delete(chat_id);
    }

    await slackApp.client.chat.postMessage({
      channel,
      thread_ts,
      text,
    });

    return { content: [{ type: "text", text: "sent" }] };
  }
  throw new Error(`unknown tool: ${req.params.name}`);
});

// ── 權限中繼：Claude Code 在工具批准對話框開啟時呼叫此處理程式 ──────────
const PermissionRequestSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(), // 5 個小寫字母（排除 'l'）
    tool_name: z.string(), // 例如 "Bash"、"Write"
    description: z.string(), // 人類可讀的操作摘要
    input_preview: z.string(), // 工具引數 JSON（截斷至約 200 字元）
    // 額外：MCP channel 會在 meta 中附帶 chat_id，但 permission_request
    // 本身不保證有 channel context，因此我們廣播到所有活躍對話
    meta: z
      .object({
        chat_id: z.string().optional(),
      })
      .optional(),
  }),
});

// 記錄最近活躍的 chat_id（用於將權限提示傳送到正確的 thread）
let lastActiveChatId: string | null = null;

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  const targetChatId = params.meta?.chat_id ?? lastActiveChatId;
  if (!targetChatId) {
    console.warn(
      "[slack-channel] No active chat_id for permission relay, skipping",
    );
    return;
  }

  const colonIdx = targetChatId.indexOf(":");
  if (colonIdx === -1) return;
  const channel = targetChatId.slice(0, colonIdx);
  const thread_ts = targetChatId.slice(colonIdx + 1);

  // 友善格式：顯示工具名稱（去除 mcp__ 前綴）與說明，不顯示 raw JSON
  const friendlyToolName = params.tool_name.replace(/^mcp__[^_]+__/, "");

  await slackApp.client.chat.postMessage({
    channel,
    thread_ts,
    text:
      `⏳ *等待授權*\n` +
      `Claude 想要執行 *${friendlyToolName}* 工具\n` +
      `說明：${params.description}\n` +
      `請由執行 Claude 的人在終端機中確認。`,
  });
});

// ── 共用：將訊息轉發給 Claude ─────────────────────────────────────────
async function forwardToClauде(params: {
  text: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  sender: string;
}): Promise<void> {
  const { text, channel, ts, sender } = params;
  const thread_ts = params.thread_ts ?? ts;
  const chat_id = `${channel}:${thread_ts}`;

  // 立即加 reaction，讓使用者確認 Bot 已收到訊息（不論是否有權限）
  await slackApp.client.reactions
    .add({
      channel,
      name: "hourglass_flowing_sand",
      timestamp: ts,
    })
    .catch(async (err) => {
      const errMsg = err?.data?.error ?? String(err);
      await slackApp.client.chat.postMessage({
        channel,
        thread_ts,
        text: `[DEBUG] reactions.add failed: \`${errMsg}\``,
      });
    });

  // 白名單檢查（default deny）
  // ALLOWED_USER_IDS 未設定 → 拒絕所有人；已設定 → 只允許名單內的使用者
  if (!ALLOWED_USER_IDS || !ALLOWED_USER_IDS.has(sender)) {
    await slackApp.client.reactions
      .remove({ channel, name: "hourglass_flowing_sand", timestamp: ts })
      .catch(() => {});
    await slackApp.client.chat.postMessage({
      channel,
      thread_ts,
      text: `⛔ 您沒有使用此 Bot 的權限。\n您的 User ID：\`${sender}\`\n如需開通，請將此 ID 加入 \`.env\` 的 \`ALLOWED_USER_IDS\`。`,
    });
    return;
  }

  pendingReactions.set(chat_id, { channel, ts });

  // 更新最近活躍的 chat_id（用於 permission relay fallback）
  lastActiveChatId = chat_id;

  // 一般訊息：轉發給 Claude
  await mcp.notification({
    method: "notifications/claude/channel",
    params: {
      content: text,
      meta: { chat_id, sender, channel, thread_ts },
    },
  });
}

// ── Slack 事件：監聽 channel 中的 @mention ────────────────────────────
slackApp.event("app_mention", async ({ event }) => {
  console.error(
    `[slack-channel] app_mention received: channel=${event.channel} user=${"user" in event ? event.user : "N/A"}`,
  );
  // 過濾 channel 白名單
  if (SLACK_CHANNEL_FILTER && !SLACK_CHANNEL_FILTER.has(event.channel)) {
    console.error(
      `[slack-channel] app_mention filtered by SLACK_CHANNEL_FILTER`,
    );
    return;
  }

  // 移除 @Bot mention 前綴
  const rawText = "text" in event ? event.text : "";
  const text = rawText.replace(/<@[A-Z0-9]+>\s*/g, "").trim();
  if (!text) return;

  await forwardToClauде({
    text,
    channel: event.channel,
    ts: event.ts,
    thread_ts: "thread_ts" in event ? event.thread_ts : undefined,
    sender: "user" in event ? event.user : "unknown",
  });
});

// ── Slack 事件：監聽 DM（direct message）─────────────────────────────
slackApp.event("message", async ({ event }) => {
  console.error(
    `[slack-channel] message event received: channel_type=${"channel_type" in event ? event.channel_type : "N/A"} subtype=${"subtype" in event ? event.subtype : "N/A"} bot_id=${"bot_id" in event ? event.bot_id : "N/A"} user=${"user" in event ? event.user : "N/A"}`,
  );
  // 只處理 DM（channel ID 以 D 開頭，或 channel_type === "im"）
  if (!("channel_type" in event) || event.channel_type !== "im") {
    console.error(`[slack-channel] message filtered: not DM`);
    return;
  }

  // 過濾 bot 自己的訊息與 subtype 訊息（例如 message_changed、bot_message）
  if ("subtype" in event && event.subtype) return;
  if ("bot_id" in event && event.bot_id) return;
  if (botUserId && "user" in event && event.user === botUserId) return;

  const text = "text" in event ? event.text?.trim() : "";
  if (!text) return;

  await forwardToClauде({
    text,
    channel: event.channel,
    ts: event.ts,
    thread_ts: "thread_ts" in event ? event.thread_ts : undefined,
    sender: "user" in event ? (event.user ?? "unknown") : "unknown",
  });
});

// ── 透過 stdio 連接到 Claude Code ─────────────────────────────────────
await mcp.connect(new StdioServerTransport());

// ── 啟動 Slack Socket Mode ────────────────────────────────────────────
await slackApp.start();
console.error(
  "[slack-channel] Slack Socket Mode connected. Ready for messages.",
);

// 取得 bot 自身 user ID
try {
  const authResult = await slackApp.client.auth.test();
  botUserId = authResult.user_id as string | undefined;
  console.error(`[slack-channel] Bot user ID: ${botUserId}`);
} catch (err) {
  console.error("[slack-channel] Failed to get bot user ID:", err);
}
