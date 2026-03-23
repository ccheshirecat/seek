import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";

const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://searxng:8080";

const server = new Server(
  { name: "seek", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "web_search",
      description:
        "Search the web with high-anonymity bypass using Chrome 137 TLS emulation. " +
        "Returns titles, URLs, and snippets from the requested search engines.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query",
          },
          engines: {
            type: "string",
            description:
              "Comma-separated list of engines to use. " +
              "Available: google, bing, duckduckgo. Defaults to all three.",
          },
          language: {
            type: "string",
            description: "Language code for results, e.g. 'en', 'fr'. Optional.",
          },
          page: {
            type: "number",
            description: "Results page number (1-based). Defaults to 1.",
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

  const args = request.params.arguments as Record<string, unknown>;
  const query = args.query as string;
  const engines = (args.engines as string | undefined) ?? "google,bing,duckduckgo";
  const language = (args.language as string | undefined) ?? "en";
  const page = (args.page as number | undefined) ?? 1;

  let resp;
  try {
    resp = await axios.get(`${SEARXNG_URL}/search`, {
      params: {
        q: query,
        engines,
        language,
        pageno: page,
        format: "json",
      },
      timeout: 30_000,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Search failed: ${message}` }],
      isError: true,
    };
  }

  const results: Array<{ title: string; url: string; content: string }> =
    resp.data?.results ?? [];

  if (results.length === 0) {
    return {
      content: [{ type: "text", text: "No results found." }],
    };
  }

  const formatted = results
    .map(
      (r, i) =>
        `[${i + 1}] ${r.title}\n` +
        `URL: ${r.url}\n` +
        `${r.content ?? ""}`.trim()
    )
    .join("\n\n");

  return {
    content: [{ type: "text", text: formatted }],
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("Seek MCP server started (stdio)\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
