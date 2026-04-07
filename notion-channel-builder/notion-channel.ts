#!/usr/bin/env bun
/**
 * Claude Code Channel Server — Notion (Polling)
 *
 * 透過 stdio 連線到 Claude Code，並透過 Notion API polling 建立單向觸發：
 *   - 每 POLL_INTERVAL_MS 毫秒查詢 DB 中 status = Ready 的 task
 *   - 轉發任務內容給 Claude 處理
 *   - Claude 透過 reply tool 將結果寫回 Notion page
 *
 * 使用方式：
 *   1. cd notion-channel-builder
 *      NOTION_API_KEY=secret_... NOTION_DATABASE_ID=... \
 *      claude --dangerously-load-development-channels server:notion
 *   2. 在 Notion DB 中將 task 的 status 改為 "Ready"
 *   3. Claude 會自動執行任務，並將結果寫回 Notion page
 *
 * 注意：此 server 不啟用 claude/channel/permission（權限中繼），
 * 建議搭配 --dangerously-skip-permissions 或在 Claude Code 中手動批准。
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@notionhq/client";

// ── 設定 ───────────────────────────────────────────────────────────────
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const DB_ID = process.env.NOTION_DATABASE_ID;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 30_000);

if (!NOTION_API_KEY || !DB_ID) {
  console.error("[notion-channel] Missing required env vars: NOTION_API_KEY, NOTION_DATABASE_ID");
  process.exit(1);
}

// ── Notion Client ─────────────────────────────────────────────────────
const notion = new Client({ auth: NOTION_API_KEY });

// ── MCP Server（Claude Code Channel）─────────────────────────────────
/**
 * chat_id = Notion page_id
 * 每個 Notion page 代表一次任務對話
 */
const mcp = new Server(
  { name: "notion", version: "0.1.0" },
  {
    capabilities: {
      experimental: {
        // 告訴 Claude Code 這是一個 channel
        "claude/channel": {},
        // 注意：此 server 不啟用 permission relay
        // 建議搭配 --dangerously-skip-permissions 使用
      },
      tools: {},
    },
    instructions:
      'Messages arrive as <channel source="notion" chat_id="PAGE_ID">. ' +
      "Each message represents a task from a Notion database card with properties: " +
      "title, type, template, description, and pageId. " +
      "Execute the task described and use the reply tool to write the result back. " +
      "The reply tool accepts chat_id (= pageId), text (result summary), and optional status " +
      '("Done" on success, "Failed" on failure). ' +
      "On failure, include the error details in the text field.",
  },
);

// ── reply tool：Claude 用此工具將結果寫回 Notion page ─────────────────
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Write the task result back to the Notion page",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: {
            type: "string",
            description: "Notion page ID from the incoming <channel> tag",
          },
          text: {
            type: "string",
            description: "Result summary to write to the agent_log property",
          },
          status: {
            type: "string",
            enum: ["Done", "Failed"],
            description: 'Final status to set on the page. Defaults to "Done"',
          },
        },
        required: ["chat_id", "text"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "reply") {
    const { chat_id, text, status } = req.params.arguments as {
      chat_id: string;
      text: string;
      status?: string;
    };

    const finalStatus = status === "Failed" ? "Failed" : "Done";

    await notion.pages.update({
      page_id: chat_id,
      properties: {
        status: { status: { name: finalStatus } },
        agent_log: {
          rich_text: [
            {
              text: { content: text.slice(0, 2000) }, // Notion rich_text 最大 2000 字元
            },
          ],
        },
      },
    });

    console.error(`[notion-channel] Page ${chat_id} updated → ${finalStatus}`);
    return { content: [{ type: "text", text: `updated to ${finalStatus}` }] };
  }
  throw new Error(`unknown tool: ${req.params.name}`);
});

// ── Notion polling loop ───────────────────────────────────────────────
async function buildMessage(page: any): Promise<string> {
  const title = page.properties.title?.title?.[0]?.plain_text ?? "(untitled)";
  const type = page.properties.type?.select?.name ?? "general";
  const template = page.properties.template?.select?.name ?? "default";
  const description = page.properties.description?.rich_text?.[0]?.plain_text ?? "";
  const pageId = page.id;

  // 根據 task type 組合不同的訊息格式
  const lines = [
    `Task: ${title}`,
    `Type: ${type}`,
    `Page ID: ${pageId}`,
  ];

  if (template !== "default") {
    lines.push(`Template: ${template}`);
  }
  if (description) {
    lines.push(`Description: ${description}`);
  }

  return lines.join("\n");
}

async function processPage(page: any): Promise<void> {
  const pageId = page.id;
  const title = page.properties.title?.title?.[0]?.plain_text ?? "(untitled)";

  console.error(`[notion-channel] Processing: ${title} (${pageId})`);

  // 立即設為 In Progress，防止重複觸發
  await notion.pages.update({
    page_id: pageId,
    properties: {
      status: { status: { name: "In Progress" } },
    },
  });

  // 組合訊息並轉發給 Claude
  const content = await buildMessage(page);

  await mcp.notification({
    method: "notifications/claude/channel",
    params: {
      content,
      meta: {
        chat_id: pageId,
        title,
        type: page.properties.type?.select?.name ?? "general",
      },
    },
  });

  console.error(`[notion-channel] Dispatched task to Claude: ${title}`);
}

async function poll(): Promise<void> {
  console.error(`[notion-channel] Polling Notion DB: ${DB_ID}`);

  let response: Awaited<ReturnType<typeof notion.databases.query>>;
  try {
    response = await notion.databases.query({
      database_id: DB_ID,
      filter: {
        property: "status",
        status: { equals: "Ready" },
      },
    });
  } catch (err) {
    console.error("[notion-channel] Failed to query Notion:", err);
    return;
  }

  const pages = response.results;
  if (pages.length === 0) {
    console.error("[notion-channel] No ready tasks.");
    return;
  }

  console.error(`[notion-channel] Found ${pages.length} ready task(s).`);

  // Sequential — 避免 git/bash race condition（若多任務同時執行）
  for (const page of pages) {
    await processPage(page);
  }
}

// ── 透過 stdio 連接到 Claude Code ─────────────────────────────────────
await mcp.connect(new StdioServerTransport());

// ── 啟動 Polling ──────────────────────────────────────────────────────
console.error(`[notion-channel] Connected. Polling every ${POLL_INTERVAL_MS}ms.`);
poll();
setInterval(poll, POLL_INTERVAL_MS);
