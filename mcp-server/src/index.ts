import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import express from "express";

const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://searxng:8080";
const TRANSPORT   = process.env.MCP_TRANSPORT ?? "stdio";   // "stdio" | "http"
const PORT        = parseInt(process.env.MCP_PORT ?? "3001");

// ---------------------------------------------------------------------------
// Result types from SearXNG JSON API
// ---------------------------------------------------------------------------
interface SearxResult {
  title:         string;
  url:           string;
  content?:      string;
  engine?:       string;
  engines?:      string[];
  publishedDate?: string;
  score?:        number;
}

interface SearxResponse {
  query:        string;
  results:      SearxResult[];
  suggestions?: string[];
  infoboxes?:   Array<{ infobox: string; content?: string; urls?: Array<{ title: string; url: string }> }>;
}

// ---------------------------------------------------------------------------
// LLM-friendly formatter
// ---------------------------------------------------------------------------
function formatResults(data: SearxResponse): string {
  const { query, results, suggestions, infoboxes } = data;
  const lines: string[] = [];

  lines.push(`Query: ${query}`);
  lines.push(`Results: ${results.length}`);
  lines.push("");

  // Infobox (Wikipedia-style knowledge panel) — most useful, put first
  if (infoboxes?.length) {
    const box = infoboxes[0];
    lines.push(`## Knowledge Panel: ${box.infobox}`);
    if (box.content) lines.push(box.content.slice(0, 400));
    if (box.urls?.length) {
      lines.push("Sources: " + box.urls.map(u => u.url).join(", "));
    }
    lines.push("");
  }

  // Main results
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const engines = r.engines?.join(", ") ?? r.engine ?? "";
    const date = r.publishedDate
      ? ` | ${r.publishedDate.slice(0, 10)}`
      : "";

    lines.push(`### [${i + 1}] ${r.title}`);
    lines.push(`URL: ${r.url}`);
    if (engines || date) lines.push(`Meta: ${engines}${date}`.trim());
    if (r.content) {
      // Trim to ~300 chars to stay token-efficient; keep full sentences
      const snippet = r.content.length > 300
        ? r.content.slice(0, 297).replace(/\s\S*$/, "") + "..."
        : r.content;
      lines.push(snippet);
    }
    lines.push("");
  }

  // Suggestions — useful for follow-up queries
  if (suggestions?.length) {
    lines.push(`Related searches: ${suggestions.slice(0, 5).join(" | ")}`);
  }

  return lines.join("\n").trimEnd();
}

// ---------------------------------------------------------------------------
// MCP server definition
// ---------------------------------------------------------------------------
const server = new Server(
  { name: "seek", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "web_search",
      description:
        "Search the web and return structured results (title, URL, snippet, source engine, date). " +
        "Uses Chrome 137 TLS emulation via rotating ISP proxies for high-fidelity results.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query",
          },
          engines: {
            type: "string",
            description:
              "Comma-separated engines: google, bing, duckduckgo. Defaults to all three.",
          },
          language: {
            type: "string",
            description: "BCP-47 language code, e.g. 'en', 'fr'. Defaults to 'en'.",
          },
          page: {
            type: "number",
            description: "Page number (1-based). Defaults to 1.",
          },
        },
        required: ["query"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "web_search") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const args     = request.params.arguments as Record<string, unknown>;
  const query    = args.query as string;
  const engines  = (args.engines  as string | undefined) ?? "google,bing,duckduckgo";
  const language = (args.language as string | undefined) ?? "en";
  const page     = (args.page     as number | undefined) ?? 1;

  let resp;
  try {
    resp = await axios.get<SearxResponse>(`${SEARXNG_URL}/search`, {
      params: { q: query, engines, language, pageno: page, format: "json" },
      timeout: 30_000,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Search failed: ${message}` }],
      isError: true,
    };
  }

  const data = resp.data;
  if (!data.results?.length) {
    return { content: [{ type: "text", text: `No results found for: ${query}` }] };
  }

  return { content: [{ type: "text", text: formatResults(data) }] };
});

// ---------------------------------------------------------------------------
// Transport: stdio or HTTP/SSE
// ---------------------------------------------------------------------------
async function main() {
  if (TRANSPORT === "http") {
    const app = express();
    app.use(express.json());

    // SSE transport: one session per GET /sse connection
    const sessions = new Map<string, SSEServerTransport>();

    app.get("/sse", async (_req, res) => {
      const transport = new SSEServerTransport("/message", res);
      sessions.set(transport.sessionId, transport);
      res.on("close", () => sessions.delete(transport.sessionId));
      await server.connect(transport);
    });

    app.post("/message", async (req, res) => {
      const id = req.query.sessionId as string;
      const transport = sessions.get(id);
      if (!transport) { res.status(404).json({ error: "Session not found" }); return; }
      // Pass req.body explicitly — express.json() already consumed the stream
      await transport.handlePostMessage(req, res, req.body);
    });

    // Health check — useful for load balancers / Claude Code remote config
    app.get("/health", (_req, res) => res.json({ status: "ok" }));

    app.listen(PORT, () =>
      process.stderr.write(`Seek MCP server (HTTP/SSE) listening on :${PORT}\n`)
    );
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write("Seek MCP server started (stdio)\n");
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
