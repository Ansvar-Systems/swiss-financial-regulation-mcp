#!/usr/bin/env node

/**
 * HTTP Server Entry Point for Docker Deployment
 *
 * Provides Streamable HTTP transport for remote MCP clients.
 * Use src/index.ts for local stdio-based usage.
 *
 * Endpoints:
 *   GET  /health  — liveness probe
 *   POST /mcp     — MCP Streamable HTTP (session-aware)
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  listSourcebooks,
  searchProvisions,
  getProvision,
  searchEnforcement,
  checkProvisionCurrency,
} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const SERVER_NAME = "swiss-financial-regulation-mcp";

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback
}

// ─── Tool definitions (shared with index.ts) ─────────────────────────────────

const TOOLS = [
  {
    name: "ch_fin_search_regulations",
    description:
      "Volltextsuche in FINMA-Rundschreiben, Verordnungen und Wegleitungen. (Full-text search across FINMA circulars, ordinances, and guidance.)",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "Suchbegriff auf Deutsch (z.B. 'Operationelle Risiken', 'Auslagerung'). Search query in German.",
        },
        sourcebook: {
          type: "string",
          description: "Filter nach Publikationskategorie. Optional.",
        },
        status: {
          type: "string",
          enum: ["in_force", "deleted", "not_yet_in_force"],
          description: "Filter nach Status. Optional.",
        },
        limit: { type: "number", description: "Maximale Anzahl Ergebnisse (Standard: 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "ch_fin_get_regulation",
    description:
      "Gibt eine spezifische FINMA-Bestimmung anhand Kategorie und Referenz zurück. (Get a specific FINMA provision by sourcebook and reference.)",
    inputSchema: {
      type: "object" as const,
      properties: {
        sourcebook: {
          type: "string",
          description: "Publikationskategorie (z.B. FINMA_Rundschreiben, FINMA_Verordnungen)",
        },
        reference: {
          type: "string",
          description: "Vollständige Referenz (z.B. 'RS 2023/1 Rz 5', 'GwV Art. 12')",
        },
      },
      required: ["sourcebook", "reference"],
    },
  },
  {
    name: "ch_fin_list_sourcebooks",
    description:
      "Listet alle FINMA-Publikationskategorien auf. (List all FINMA publication categories.)",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "ch_fin_search_enforcement",
    description:
      "Sucht in FINMA-Durchsetzungsmassnahmen und Verfügungen. (Search FINMA enforcement actions — proceedings, fines, licence withdrawals.)",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Suchbegriff (Firmenname, Verstossart, etc.)",
        },
        action_type: {
          type: "string",
          enum: ["fine", "licence_withdrawal", "recovery", "restriction", "warning"],
          description: "Filter nach Massnahmentyp. Optional.",
        },
        limit: { type: "number", description: "Maximale Anzahl Ergebnisse (Standard: 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "ch_fin_check_currency",
    description:
      "Prüft, ob eine FINMA-Bestimmung aktuell in Kraft ist. (Check whether a FINMA provision is currently in force.)",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: {
          type: "string",
          description: "Vollständige Referenz der Bestimmung (z.B. 'RS 2023/1 Rz 5')",
        },
      },
      required: ["reference"],
    },
  },
  {
    name: "ch_fin_about",
    description:
      "Gibt Metadaten zu diesem MCP-Server zurück. (Return metadata about this MCP server.)",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const SearchRegulationsArgs = z.object({
  query: z.string().min(1),
  sourcebook: z.string().optional(),
  status: z.enum(["in_force", "deleted", "not_yet_in_force"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetRegulationArgs = z.object({
  sourcebook: z.string().min(1),
  reference: z.string().min(1),
});

const SearchEnforcementArgs = z.object({
  query: z.string().min(1),
  action_type: z
    .enum(["fine", "licence_withdrawal", "recovery", "restriction", "warning"])
    .optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const CheckCurrencyArgs = z.object({
  reference: z.string().min(1),
});

// ─── MCP server factory ──────────────────────────────────────────────────────

function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: pkgVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    function textContent(data: unknown) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }

    function errorContent(message: string) {
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true as const,
      };
    }

    try {
      switch (name) {
        case "ch_fin_search_regulations": {
          const parsed = SearchRegulationsArgs.parse(args);
          const results = searchProvisions({
            query: parsed.query,
            sourcebook: parsed.sourcebook,
            status: parsed.status,
            limit: parsed.limit,
          });
          return textContent({ results, count: results.length });
        }

        case "ch_fin_get_regulation": {
          const parsed = GetRegulationArgs.parse(args);
          const provision = getProvision(parsed.sourcebook, parsed.reference);
          if (!provision) {
            return errorContent(
              `Bestimmung nicht gefunden: ${parsed.sourcebook} ${parsed.reference}`,
            );
          }
          return textContent(provision);
        }

        case "ch_fin_list_sourcebooks": {
          const sourcebooks = listSourcebooks();
          return textContent({ sourcebooks, count: sourcebooks.length });
        }

        case "ch_fin_search_enforcement": {
          const parsed = SearchEnforcementArgs.parse(args);
          const results = searchEnforcement({
            query: parsed.query,
            action_type: parsed.action_type,
            limit: parsed.limit,
          });
          return textContent({ results, count: results.length });
        }

        case "ch_fin_check_currency": {
          const parsed = CheckCurrencyArgs.parse(args);
          const currency = checkProvisionCurrency(parsed.reference);
          return textContent(currency);
        }

        case "ch_fin_about": {
          return textContent({
            name: SERVER_NAME,
            version: pkgVersion,
            description:
              "FINMA (Eidgenössische Finanzmarktaufsicht) MCP-Server. Bietet Zugang zu Rundschreiben, Verordnungen, Wegleitungen, Aufsichtsmitteilungen und Durchsetzungsmassnahmen der FINMA.",
            data_source: "FINMA (https://www.finma.ch/)",
            tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
          });
        }

        default:
          return errorContent(`Unbekanntes Tool: ${name}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorContent(`Fehler bei ${name}: ${message}`);
    }
  });

  return server;
}

// ─── HTTP server ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server }
  >();

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, sessions).catch((err) => {
      console.error(`[${SERVER_NAME}] Unhandled error:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  async function handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    activeSessions: Map<
      string,
      { transport: StreamableHTTPServerTransport; server: Server }
    >,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: pkgVersion }));
      return;
    }

    if (url.pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        return;
      }

      // New session — create a fresh MCP server instance per session
      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type mismatch with exactOptionalPropertyTypes
      await mcpServer.connect(transport as any);

      transport.onclose = () => {
        if (transport.sessionId) {
          activeSessions.delete(transport.sessionId);
        }
        mcpServer.close().catch(() => {});
      };

      await transport.handleRequest(req, res);

      // Store AFTER handleRequest — sessionId is set during initialize
      if (transport.sessionId) {
        activeSessions.set(transport.sessionId, { transport, server: mcpServer });
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  httpServer.listen(PORT, () => {
    console.error(`${SERVER_NAME} v${pkgVersion} (HTTP) listening on port ${PORT}`);
    console.error(`MCP endpoint:  http://localhost:${PORT}/mcp`);
    console.error(`Health check:  http://localhost:${PORT}/health`);
  });

  process.on("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down...");
    httpServer.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
