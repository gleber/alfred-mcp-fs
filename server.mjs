import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";

const DATA_DIR = "/second-brain";
const IGNORED_DIRS = new Set(["Library", "_plug", "Repositories"]);
const app = express();
app.use(express.json());

const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const transports = {};

function log(...args) {
  console.error(new Date().toISOString(), ...args);
}

app.use((req, res, next) => {
  const hasToken =
    req.headers.authorization === `Bearer ${AUTH_TOKEN}` ||
    req.query.token === AUTH_TOKEN;
  const sessionId = req.headers["mcp-session-id"];
  const hasSession = sessionId && transports[sessionId];
  log(`${req.method} ${req.path} session=${sessionId || "none"} auth=${hasToken} sessionOk=${!!hasSession}`);
  if (hasToken || hasSession) {
    next();
  } else {
    log("401 Unauthorized");
    res.status(401).json({ error: "Unauthorized" });
  }
});

function safePath(rel) {
  const abs = path.resolve(DATA_DIR, rel);
  if (!abs.startsWith(DATA_DIR + path.sep) && abs !== DATA_DIR) {
    throw new Error("Path outside data directory");
  }
  const relative = path.relative(DATA_DIR, abs);
  const topDir = relative.split(path.sep)[0];
  if (IGNORED_DIRS.has(topDir)) {
    throw new Error(`Access to '${topDir}' is not allowed`);
  }
  return abs;
}

function makeServer() {
  const server = new Server(
    { name: "alfred-fs", version: "1.0.0", description: "MCP server for Alfred's brain — the knowledge base of a personal assistant. Provides read/write access to Alfred's second-brain notes and documents." },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_files",
        description: "List files in the second-brain directory (recursively). Optionally filter by extension.",
        inputSchema: {
          type: "object",
          properties: {
            dir: { type: "string", description: "Subdirectory to list (relative to second-brain root, default: root)" },
            ext: { type: "string", description: "File extension filter e.g. '.md'" },
          },
        },
      },
      {
        name: "read_file",
        description: "Read the contents of a file in the second-brain directory.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path relative to second-brain root" },
          },
          required: ["path"],
        },
      },
      {
        name: "write_file",
        description: "Write (create or overwrite) a file in the second-brain directory.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path relative to second-brain root" },
            content: { type: "string", description: "Content to write" },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "search_files",
        description: "Search for a text pattern across files in the second-brain directory.",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Text or regex pattern to search for" },
            dir: { type: "string", description: "Subdirectory to search in (default: root)" },
            ext: { type: "string", description: "Limit search to files with this extension e.g. '.md'" },
          },
          required: ["pattern"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    log(`Tool call: ${name}`, JSON.stringify(args));

    if (name === "list_files") {
      const base = safePath(args?.dir || ".");
      const ext = args?.ext || null;
      const results = [];
      async function walk(dir) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.name.startsWith(".")) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (IGNORED_DIRS.has(e.name)) continue;
            await walk(full);
          } else if (!ext || e.name.endsWith(ext)) {
            results.push(path.relative(DATA_DIR, full));
          }
        }
      }
      await walk(base);
      return { content: [{ type: "text", text: results.join("\n") }] };
    }

    if (name === "read_file") {
      const abs = safePath(args.path);
      const content = await fs.readFile(abs, "utf8");
      return { content: [{ type: "text", text: content }] };
    }

    if (name === "write_file") {
      const abs = safePath(args.path);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, args.content, "utf8");
      return { content: [{ type: "text", text: `Written: ${args.path}` }] };
    }

    if (name === "search_files") {
      const base = safePath(args?.dir || ".");
      const ext = args?.ext || null;
      const regex = new RegExp(args.pattern, "i");
      const results = [];
      async function walk(dir) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.name.startsWith(".")) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (IGNORED_DIRS.has(e.name)) continue;
            await walk(full);
          } else if (!ext || e.name.endsWith(ext)) {
            const text = await fs.readFile(full, "utf8").catch(() => "");
            const lines = text.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                results.push(`${path.relative(DATA_DIR, full)}:${i + 1}: ${lines[i].trim()}`);
              }
            }
          }
        }
      }
      await walk(base);
      return { content: [{ type: "text", text: results.join("\n") || "No matches" }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  return server;
}

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  let transport = sessionId && transports[sessionId];
  if (sessionId && !transport) {
    log(`Unknown session ID: ${sessionId} — rejecting`);
    res.status(404).json({ error: "Session not found" });
    return;
  }
  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        log(`Session initialized: ${sid}`);
        transports[sid] = transport;
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        log(`Session closed: ${transport.sessionId}`);
        delete transports[transport.sessionId];
      }
    };
    const server = makeServer();
    await server.connect(transport);
  }
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = transports[sessionId];
  if (!transport) { res.status(400).json({ error: "No session" }); return; }
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = transports[sessionId];
  if (!transport) { res.status(400).json({ error: "No session" }); return; }
  await transport.handleRequest(req, res);
});

app.listen(3775, "127.0.0.1", () => console.log("MCP listening on 3775"));
