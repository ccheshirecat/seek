import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import express from "express";
import rateLimit from "express-rate-limit";

const SEARXNG_URL   = process.env.SEARXNG_URL   ?? "http://searxng:8080";
const TRANSPORT     = process.env.MCP_TRANSPORT ?? "stdio";
const PORT          = parseInt(process.env.MCP_PORT          ?? "3001");
const MAX_SESSIONS  = parseInt(process.env.MAX_SESSIONS      ?? "200");
const CACHE_TTL_MS  = parseInt(process.env.CACHE_TTL_MS      ?? "60000");  // 60s
const RATE_LIMIT    = parseInt(process.env.RATE_LIMIT_PER_MIN ?? "30");
const MAX_QUERY_LEN = 500;

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
// In-memory query cache
// ---------------------------------------------------------------------------
interface CacheEntry { data: SearxResponse; expiresAt: number; }
const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): SearxResponse | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { cache.delete(key); return null; }
  return entry.data;
}

function cacheSet(key: string, data: SearxResponse): void {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  // Evict expired entries when cache grows large
  if (cache.size > 1000) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now > v.expiresAt) cache.delete(k);
    }
  }
}

// ---------------------------------------------------------------------------
// Search fetcher with fallback + deduplication
// ---------------------------------------------------------------------------

/** Deduplicate results by URL, keeping the entry with the longest snippet. */
function dedup(results: SearxResult[]): SearxResult[] {
  const seen = new Map<string, SearxResult>();
  for (const r of results) {
    const existing = seen.get(r.url);
    if (!existing || (r.content?.length ?? 0) > (existing.content?.length ?? 0)) {
      seen.set(r.url, r);
    }
  }
  return Array.from(seen.values());
}

async function searxRequest(
  query: string,
  page: number,
  engines?: string
): Promise<SearxResponse | null> {
  try {
    const params: Record<string, unknown> = {
      q: query,
      language: "en",
      pageno: page,
      format: "json",
    };
    if (engines) params.engines = engines;

    const resp = await axios.get<SearxResponse>(`${SEARXNG_URL}/search`, {
      params,
      timeout: 30_000,
    });
    return resp.data;
  } catch {
    return null;
  }
}

/**
 * Strategy:
 *   1. Try all three engines simultaneously.
 *   2. If < 3 results, fall back to SearXNG's own default engine selection.
 *   3. Deduplicate across engines by URL.
 */
async function fetchWithFallback(
  query: string,
  page: number
): Promise<SearxResponse | null> {
  const cacheKey = `${query}::${page}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const data = await searxRequest(query, page, "google,bing,duckduckgo");

  if (data && (data.results?.length ?? 0) >= 3) {
    data.results = dedup(data.results);
    cacheSet(cacheKey, data);
    return data;
  }

  // Fallback: let SearXNG pick engines
  const fallback = await searxRequest(query, page);
  if (!fallback) return data;

  // Merge results from both attempts, then dedup
  const merged = [...(data?.results ?? []), ...(fallback.results ?? [])];
  fallback.results = dedup(merged);
  fallback.suggestions = [
    ...new Set([...(data?.suggestions ?? []), ...(fallback.suggestions ?? [])]),
  ];
  if (fallback.results.length > 0) cacheSet(cacheKey, fallback);
  return fallback;
}

// ---------------------------------------------------------------------------
// MCP server factory — one instance per connection (required for SSE multi-client)
// ---------------------------------------------------------------------------
function makeServer(): Server {
  const s = new Server(
    { name: "seek", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  s.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "web_search",
        description:
          "Search the web. Returns ranked, deduplicated results with title, URL, snippet, source, and date.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query",
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

  s.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "web_search") {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }

    const args  = request.params.arguments as Record<string, unknown>;
    const query = (args.query as string).trim();
    const page  = (args.page as number | undefined) ?? 1;

    if (!query) {
      return { content: [{ type: "text", text: "Query cannot be empty." }], isError: true };
    }
    if (query.length > MAX_QUERY_LEN) {
      return { content: [{ type: "text", text: `Query too long (max ${MAX_QUERY_LEN} characters).` }], isError: true };
    }

    const data = await fetchWithFallback(query, page);
    if (!data) {
      return {
        content: [{ type: "text", text: `Search failed for: ${query}` }],
        isError: true,
      };
    }

    if (!data.results?.length) {
      return { content: [{ type: "text", text: `No results found for: ${query}` }] };
    }

    return { content: [{ type: "text", text: formatResults(data) }] };
  });

  return s;
}

// ---------------------------------------------------------------------------
// Transport: stdio or HTTP/SSE
// ---------------------------------------------------------------------------
async function main() {
  if (TRANSPORT === "http") {
    const app = express();
    app.use(express.json());
    app.set("trust proxy", 1); // respect X-Forwarded-For from reverse proxy

    // Rate limit: per IP across all endpoints
    app.use(rateLimit({
      windowMs: 60_000,
      max: RATE_LIMIT,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: `Too many requests — limit is ${RATE_LIMIT}/min` },
    }));

    // Basic request logging
    app.use((req, _res, next) => {
      const ip = req.ip ?? "unknown";
      process.stderr.write(`[${new Date().toISOString()}] ${req.method} ${req.path} — ${ip}\n`);
      next();
    });

    const sessions = new Map<string, SSEServerTransport>();

    app.get("/sse", async (_req, res) => {
      // Session cap — prevent memory exhaustion
      if (sessions.size >= MAX_SESSIONS) {
        res.status(503).json({ error: "Server at capacity, try again later." });
        return;
      }
      const transport = new SSEServerTransport("/message", res);
      sessions.set(transport.sessionId, transport);
      res.on("close", () => sessions.delete(transport.sessionId));
      await makeServer().connect(transport);
    });

    app.post("/message", async (req, res) => {
      const id = req.query.sessionId as string;
      const transport = sessions.get(id);
      if (!transport) { res.status(404).json({ error: "Session not found" }); return; }
      await transport.handlePostMessage(req, res, req.body);
    });

    app.get("/health", (_req, res) =>
      res.json({ status: "ok", sessions: sessions.size, cached: cache.size })
    );

    const httpServer = app.listen(PORT, () =>
      process.stderr.write(`Seek MCP server (HTTP/SSE) listening on :${PORT}\n`)
    );

    // Graceful shutdown — close existing SSE connections, then exit
    const shutdown = () => {
      process.stderr.write("Shutting down...\n");
      httpServer.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 10_000).unref(); // force-exit after 10s
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT",  shutdown);
  } else {
    const transport = new StdioServerTransport();
    await makeServer().connect(transport);
    process.stderr.write("Seek MCP server started (stdio)\n");
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
