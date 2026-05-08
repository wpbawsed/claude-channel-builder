#!/usr/bin/env bun
/**
 * Claude Code Channel Server — Jira (Webhook)
 *
 * 透過 stdio 連線到 Claude Code，並提供 HTTP webhook 入口：
 *   - Jira 事件打到 POST /webhook/jira
 *   - 轉發 issue 內容給 Claude
 *   - Claude 透過 reply tool 回寫 comment，並可選擇轉換狀態
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

type JiraIssue = {
  key: string;
  id?: string;
  fields?: {
    summary?: string;
    description?: unknown;
    project?: { key?: string };
    status?: { name?: string };
    issuetype?: { name?: string };
    priority?: { name?: string };
    assignee?: { displayName?: string | null } | null;
    reporter?: { displayName?: string | null } | null;
  };
};

type JiraTransition = {
  id: string;
  name: string;
};

const JIRA_BASE_URL = (process.env.JIRA_BASE_URL ?? "").replace(/\/$/, "");
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const PORT = Number(process.env.PORT ?? 8789);
const WEBHOOK_PATH = process.env.WEBHOOK_PATH?.trim() || "/webhook/jira";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET?.trim() || "";
const JIRA_ALLOWED_EVENTS = new Set(
  (process.env.JIRA_ALLOWED_EVENTS ?? "jira:issue_created,jira:issue_updated")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const ALLOWED_PROJECT_KEYS = new Set(
  (process.env.ALLOWED_PROJECT_KEYS ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
);
const REQUIRED_STATUS = process.env.REQUIRED_STATUS?.trim() || "";
const CLAIM_STATUS = process.env.CLAIM_STATUS?.trim() || "";
const DONE_STATUS = process.env.DONE_STATUS?.trim() || "Done";
const FAILED_STATUS = process.env.FAILED_STATUS?.trim() || "To Do";

if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
  console.error(
    "[jira-channel] Missing required env vars: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN",
  );
  process.exit(1);
}

const authHeader = `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64")}`;
const processingIssueKeys = new Set<string>();

async function jiraRequest(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<any> {
  const method = init?.method ?? "GET";
  const response = await fetch(`${JIRA_BASE_URL}/rest/api/3${path}`, {
    method,
    headers: {
      Authorization: authHeader,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `${method} ${path} failed (${response.status}): ${errorText}`,
    );
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function adfToPlainText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;

  if (Array.isArray(node)) {
    return node.map((n) => adfToPlainText(n)).join("");
  }

  if (node.type === "text") {
    return String(node.text ?? "");
  }

  const content = Array.isArray(node.content) ? node.content : [];
  const text = content.map((child: any) => adfToPlainText(child)).join("");

  if (
    ["paragraph", "heading", "blockquote", "codeBlock", "listItem"].includes(
      node.type,
    )
  ) {
    return `${text}\n`;
  }
  return text;
}

function getIssueDescription(issue: JiraIssue): string {
  const rawDescription = issue.fields?.description;
  if (!rawDescription) return "";

  if (typeof rawDescription === "string") {
    return rawDescription.trim();
  }

  return adfToPlainText(rawDescription)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function getIssueTransitions(
  issueKey: string,
): Promise<JiraTransition[]> {
  const data = await jiraRequest(
    `/issue/${encodeURIComponent(issueKey)}/transitions`,
  );
  return Array.isArray(data?.transitions) ? data.transitions : [];
}

async function transitionIssueByName(
  issueKey: string,
  transitionName: string,
): Promise<boolean> {
  const normalizedTarget = transitionName.trim().toLowerCase();
  if (!normalizedTarget) return false;

  const transitions = await getIssueTransitions(issueKey);
  const target = transitions.find(
    (t) => t.name.trim().toLowerCase() === normalizedTarget,
  );
  if (!target) {
    console.error(
      `[jira-channel] Transition not found for ${issueKey}: ${transitionName}. ` +
        `Available: ${transitions.map((t) => t.name).join(", ")}`,
    );
    return false;
  }

  await jiraRequest(`/issue/${encodeURIComponent(issueKey)}/transitions`, {
    method: "POST",
    body: { transition: { id: target.id } },
  });

  return true;
}

async function addCommentToIssue(
  issueKey: string,
  text: string,
): Promise<void> {
  const safeText = text.slice(0, 30_000);

  await jiraRequest(`/issue/${encodeURIComponent(issueKey)}/comment`, {
    method: "POST",
    body: {
      body: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: safeText }],
          },
        ],
      },
    },
  });
}

const mcp = new Server(
  { name: "jira", version: "0.1.0" },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
      },
      tools: {},
    },
    instructions:
      'Messages arrive as <channel source="jira" chat_id="ISSUE_KEY">. ' +
      "Each message represents one Jira issue sent by webhook events. " +
      "Do the requested task and use the reply tool to write result back to Jira comment. " +
      "If finished, set status=Done. If failed, set status=Failed with clear reason.",
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description:
        "Write task result back to Jira issue comment and optionally transition status",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: {
            type: "string",
            description:
              "Jira issue key from incoming <channel> tag, e.g. DEVOPS-123",
          },
          text: {
            type: "string",
            description: "Result message to append as Jira comment",
          },
          status: {
            type: "string",
            enum: ["Done", "Failed", "CommentOnly"],
            description:
              "Optional final action. Done/Failed will try status transition.",
          },
        },
        required: ["chat_id", "text"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "reply") {
    throw new Error(`unknown tool: ${req.params.name}`);
  }

  const { chat_id, text, status } = req.params.arguments as {
    chat_id: string;
    text: string;
    status?: "Done" | "Failed" | "CommentOnly";
  };

  await addCommentToIssue(chat_id, text);

  if (status === "Done" && DONE_STATUS) {
    await transitionIssueByName(chat_id, DONE_STATUS);
  } else if (status === "Failed" && FAILED_STATUS) {
    await transitionIssueByName(chat_id, FAILED_STATUS);
  }

  return { content: [{ type: "text", text: "updated" }] };
});

async function processIssue(issue: JiraIssue): Promise<void> {
  const issueKey = issue.key;
  if (!issueKey || processingIssueKeys.has(issueKey)) {
    return;
  }

  processingIssueKeys.add(issueKey);

  try {
    if (CLAIM_STATUS) {
      await transitionIssueByName(issueKey, CLAIM_STATUS).catch((err) => {
        console.error(`[jira-channel] Failed to claim ${issueKey}:`, err);
      });
    }

    const summary = issue.fields?.summary ?? "(no summary)";
    const description = getIssueDescription(issue);
    const issueType = issue.fields?.issuetype?.name ?? "Unknown";
    const priority = issue.fields?.priority?.name ?? "Unknown";
    const currentStatus = issue.fields?.status?.name ?? "Unknown";
    const assignee = issue.fields?.assignee?.displayName ?? "Unassigned";
    const reporter = issue.fields?.reporter?.displayName ?? "Unknown";
    const issueUrl = `${JIRA_BASE_URL}/browse/${issueKey}`;

    const lines = [
      `Issue: ${issueKey}`,
      `Summary: ${summary}`,
      `Type: ${issueType}`,
      `Priority: ${priority}`,
      `Status: ${currentStatus}`,
      `Assignee: ${assignee}`,
      `Reporter: ${reporter}`,
      `URL: ${issueUrl}`,
    ];

    if (description) {
      lines.push("Description:", description.slice(0, 6000));
    }

    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: lines.join("\n"),
        meta: {
          chat_id: issueKey,
          issue_key: issueKey,
          issue_url: issueUrl,
        },
      },
    });

    console.error(`[jira-channel] Dispatched issue: ${issueKey}`);
  } finally {
    processingIssueKeys.delete(issueKey);
  }
}

function isEventAllowed(webhookEvent: string): boolean {
  if (JIRA_ALLOWED_EVENTS.size === 0) {
    return true;
  }
  return JIRA_ALLOWED_EVENTS.has(webhookEvent);
}

function isProjectAllowed(issue: JiraIssue): boolean {
  if (ALLOWED_PROJECT_KEYS.size === 0) {
    return true;
  }
  const key = issue.fields?.project?.key?.toUpperCase() ?? "";
  return ALLOWED_PROJECT_KEYS.has(key);
}

function isStatusAllowed(issue: JiraIssue): boolean {
  if (!REQUIRED_STATUS) {
    return true;
  }
  const statusName = issue.fields?.status?.name?.trim().toLowerCase() ?? "";
  return statusName === REQUIRED_STATUS.trim().toLowerCase();
}

await mcp.connect(new StdioServerTransport());
const normalizedWebhookPath = WEBHOOK_PATH.startsWith("/")
  ? WEBHOOK_PATH
  : `/${WEBHOOK_PATH}`;

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return new Response("ok");
    }

    if (req.method !== "POST" || url.pathname !== normalizedWebhookPath) {
      return new Response("Not found", { status: 404 });
    }

    if (WEBHOOK_SECRET) {
      const tokenFromHeader = req.headers.get("x-webhook-token") ?? "";
      const tokenFromQuery = url.searchParams.get("token") ?? "";
      if (
        tokenFromHeader !== WEBHOOK_SECRET &&
        tokenFromQuery !== WEBHOOK_SECRET
      ) {
        return new Response("Forbidden", { status: 403 });
      }
    }

    let payload: any;
    try {
      payload = await req.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const webhookEvent = String(payload?.webhookEvent ?? "");
    const issue = payload?.issue as JiraIssue | undefined;

    if (!issue?.key) {
      return new Response("Ignored: no issue in payload", { status: 202 });
    }

    if (!isEventAllowed(webhookEvent)) {
      return new Response(`Ignored event: ${webhookEvent}`, { status: 202 });
    }

    if (!isProjectAllowed(issue)) {
      return new Response("Ignored project", { status: 202 });
    }

    if (!isStatusAllowed(issue)) {
      return new Response("Ignored status", { status: 202 });
    }

    void processIssue(issue).catch((err) => {
      console.error("[jira-channel] Failed to process webhook issue:", err);
    });

    return new Response("accepted", { status: 202 });
  },
});

console.error(
  `[jira-channel] Connected. Webhook listening at http://0.0.0.0:${PORT}${normalizedWebhookPath}`,
);
