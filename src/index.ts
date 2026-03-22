#!/usr/bin/env node

/**
 * Swiss Financial Regulation MCP — stdio entry point.
 *
 * Provides MCP tools for querying FINMA regulatory publications: Rundschreiben,
 * Verordnungen, Wegleitungen, Aufsichtsmitteilungen, and enforcement proceedings.
 *
 * Tool prefix: ch_fin_
 * Primary language: German
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback to default
}

const SERVER_NAME = "swiss-financial-regulation-mcp";

// ─── Tool definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "ch_fin_search_regulations",
    description:
      "Volltextsuche in FINMA-Rundschreiben, Verordnungen und Wegleitungen. Gibt passende Bestimmungen, Anforderungen und Leitlinien zurück. (Full-text search across FINMA circulars, ordinances, and guidance. Returns matching requirements and provisions.)",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "Suchbegriff auf Deutsch (z.B. 'Operationelle Risiken', 'Auslagerung', 'Geldwäschereibekämpfung'). Search query in German.",
        },
        sourcebook: {
          type: "string",
          description:
            "Filter nach Publikationskategorie (z.B. FINMA_Rundschreiben, FINMA_Verordnungen). Optional.",
        },
        status: {
          type: "string",
          enum: ["in_force", "deleted", "not_yet_in_force"],
          description: "Filter nach Status der Bestimmung. Optional.",
        },
        limit: {
          type: "number",
          description: "Maximale Anzahl Ergebnisse. Standard: 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "ch_fin_get_regulation",
    description:
      "Gibt eine spezifische FINMA-Bestimmung anhand der Kategorie und Referenz zurück. (Get a specific FINMA provision by sourcebook and reference, e.g. 'RS 2023/1 Rz 5'.)",
    inputSchema: {
      type: "object" as const,
      properties: {
        sourcebook: {
          type: "string",
          description:
            "Publikationskategorie (z.B. FINMA_Rundschreiben, FINMA_Verordnungen, FINMA_Wegleitungen)",
        },
        reference: {
          type: "string",
          description:
            "Vollständige Referenz (z.B. 'RS 2023/1 Rz 5', 'RS 2018/3 Art. 3', 'GwV Art. 12')",
        },
      },
      required: ["sourcebook", "reference"],
    },
  },
  {
    name: "ch_fin_list_sourcebooks",
    description:
      "Listet alle FINMA-Publikationskategorien mit Namen und Beschreibungen auf. (List all FINMA publication categories with names and descriptions.)",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "ch_fin_search_enforcement",
    description:
      "Sucht in FINMA-Durchsetzungsmassnahmen und Verfügungen. (Search FINMA enforcement actions — proceedings, fines, licence withdrawals, and recovery proceedings.)",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "Suchbegriff (z.B. Firmenname, Art des Verstosses, 'Geldwäscherei'). Search query (firm name, breach type, etc.)",
        },
        action_type: {
          type: "string",
          enum: ["fine", "licence_withdrawal", "recovery", "restriction", "warning"],
          description: "Filter nach Massnahmentyp. Optional.",
        },
        limit: {
          type: "number",
          description: "Maximale Anzahl Ergebnisse. Standard: 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "ch_fin_check_currency",
    description:
      "Prüft, ob eine FINMA-Bestimmung aktuell in Kraft ist. (Check whether a specific FINMA provision reference is currently in force.)",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: {
          type: "string",
          description:
            "Vollständige Referenz der zu prüfenden Bestimmung (z.B. 'RS 2023/1 Rz 5')",
        },
      },
      required: ["reference"],
    },
  },
  {
    name: "ch_fin_about",
    description:
      "Gibt Metadaten zu diesem MCP-Server zurück: Version, Datenquelle, Tool-Liste. (Return metadata about this MCP server: version, data source, tool list.)",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// ─── Zod schemas for argument validation ────────────────────────────────────

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

// ─── Helper ──────────────────────────────────────────────────────────────────

function textContent(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

function errorContent(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

// ─── Server setup ────────────────────────────────────────────────────────────

const server = new Server(
  { name: SERVER_NAME, version: pkgVersion },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

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

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
