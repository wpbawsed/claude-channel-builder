#!/usr/bin/env bun
/**
 * Claude Code Channel Server
 *
 * 透過 stdio 連線到 Claude Code，並在 localhost:8788 上提供 HTTP 端點：
 *   POST /          — 入站訊息（轉發給 Claude）
 *   GET  /events    — SSE 串流（即時觀察 Claude 的回覆與權限提示）
 *
 * 測試方式（需要三個終端機）：
 *   1. claude --dangerously-load-development-channels server:webhook
 *   2. curl -N localhost:8788/events
 *   3. curl -d "列出當前目錄的檔案" -H "X-Sender: dev" localhost:8788
 *
 * 批准工具權限：
 *   curl -d "yes <id>" -H "X-Sender: dev" localhost:8788
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// ── 設定 ───────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 8788);

/**
 * 允許清單：只有此集合內的 X-Sender 標頭值才能傳送訊息給 Claude。
 * 正式環境請從環境變數或設定檔載入，勿寫死在程式碼中。
 *
 * 為何需要此機制：channel 是提示注入向量。
 * 任何可到達此端點的人都可以在 Claude 面前放置任意文字，因此
 * 必須在呼叫 mcp.notification() 之前驗證寄件者身份。
 */
const ALLOWED_SENDERS = new Set(
  (process.env.ALLOWED_SENDERS ?? "dev")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

// ── 出站廣播（SSE）────────────────────────────────────────────────────
// 真實的 Slack/Telegram 橋接會改為 POST 到各平台的 API。
const listeners = new Set<(chunk: string) => void>();

function send(text: string): void {
  const chunk =
    text
      .split("\n")
      .map((l) => `data: ${l}\n`)
      .join("") + "\n";
  for (const emit of listeners) emit(chunk);
}

// ── MCP Server（Claude Code Channel）─────────────────────────────────
const mcp = new Server(
  { name: "webhook", version: "0.1.0" },
  {
    capabilities: {
      experimental: {
        // 必需：告訴 Claude Code 這是一個 channel
        "claude/channel": {},
        // 可選：選擇加入遠端權限中繼
        "claude/channel/permission": {},
      },
      // 必需（雙向）：讓 Claude 發現回覆工具
      tools: {},
    },
    instructions:
      'Messages arrive as <channel source="webhook" chat_id="...">. ' +
      "Read each message carefully and reply with the reply tool, " +
      "passing the chat_id from the tag.",
  },
);

// ── 工具：Claude 用此工具將訊息回傳到 channel ─────────────────────────
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a message back over this channel",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: {
            type: "string",
            description: "Chat identifier from the incoming <channel> tag",
          },
          text: { type: "string", description: "The reply message to send" },
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
    send(`[Reply → ${chat_id}] ${text}`);
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
  }),
});

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  send(
    `⚠️  Claude 想執行 ${params.tool_name}：${params.description}\n` +
      `   引數預覽：${params.input_preview}\n\n` +
      `   請回覆 "yes ${params.request_id}" 允許，或 "no ${params.request_id}" 拒絕。`,
  );
});

// ── 透過 stdio 連接到 Claude Code ─────────────────────────────────────
await mcp.connect(new StdioServerTransport());

// ── HTTP 伺服器 ────────────────────────────────────────────────────────
// 符合 Claude Code 生成的 request_id 格式：5 個字母（排除 'l'）
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

let nextChatId = 1;

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1", // 僅限 localhost，防止外部存取
  idleTimeout: 0, // 不自動關閉閒置的 SSE 串流
  async fetch(req) {
    const url = new URL(req.url);

    // GET /events — SSE 串流，用於即時觀察 Claude 的回覆與權限提示
    if (req.method === "GET" && url.pathname === "/events") {
      const stream = new ReadableStream<string>({
        start(ctrl) {
          ctrl.enqueue(": connected\n\n"); // 讓 curl 立即顯示連線確認
          const emit = (chunk: string) => ctrl.enqueue(chunk);
          listeners.add(emit);
          req.signal.addEventListener("abort", () => listeners.delete(emit));
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    }

    // 所有其他請求視為入站訊息
    const body = await req.text();

    // 安全：先根據 X-Sender 標頭驗證寄件者身份
    const sender = req.headers.get("X-Sender") ?? "";
    if (!ALLOWED_SENDERS.has(sender)) {
      return new Response("Forbidden: sender not in allowlist", {
        status: 403,
      });
    }

    // 判斷是否為工具使用批准/拒絕回覆
    const m = PERMISSION_REPLY_RE.exec(body);
    if (m) {
      await mcp.notification({
        method: "notifications/claude/channel/permission",
        params: {
          request_id: m[2].toLowerCase(), // 正規化，避免手機自動大寫造成問題
          behavior: m[1].toLowerCase().startsWith("y") ? "allow" : "deny",
        },
      });
      return new Response("verdict recorded");
    }

    // 一般聊天訊息：轉發給 Claude
    const chat_id = String(nextChatId++);
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: body,
        meta: {
          chat_id,
          path: url.pathname,
          method: req.method,
          sender,
        },
      },
    });
    return new Response("ok");
  },
});

// 伺服器就緒訊息（輸出到 stderr，避免污染 stdio MCP 協議）
process.stderr.write(
  `[webhook-channel] HTTP server listening on http://127.0.0.1:${PORT}\n`,
);
