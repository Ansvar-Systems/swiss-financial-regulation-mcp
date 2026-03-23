#!/usr/bin/env npx tsx
/**
 * FINMA ingestion crawler.
 *
 * Crawls finma.ch for Rundschreiben (circulars), Verordnungen (ordinances),
 * Wegleitungen (guidance), Aufsichtsmitteilungen (supervisory notices), and
 * enforcement actions. Inserts everything into the SQLite database defined
 * by src/db.ts.
 *
 * Primary language: German (finma.ch/de/).
 *
 * Usage:
 *   npx tsx scripts/ingest-finma.ts                # full run
 *   npx tsx scripts/ingest-finma.ts --resume       # skip already-ingested references
 *   npx tsx scripts/ingest-finma.ts --dry-run      # crawl + log, do not write DB
 *   npx tsx scripts/ingest-finma.ts --force        # drop DB and re-ingest from scratch
 */

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

// ── Configuration ───────────────────────────────────────────────────────────

const DB_PATH = process.env["FINMA_DB_PATH"] ?? "data/finma.db";
const BASE_URL = "https://www.finma.ch";
const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 2000;
const REQUEST_TIMEOUT_MS = 30_000;

const USER_AGENT =
  "AnsvarFINMAIngester/1.0 (+https://ansvar.eu; compliance-research)";

// ── CLI flags ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const FLAG_RESUME = args.includes("--resume");
const FLAG_DRY_RUN = args.includes("--dry-run");
const FLAG_FORCE = args.includes("--force");

// ── Logging ─────────────────────────────────────────────────────────────────

interface Stats {
  pages_fetched: number;
  provisions_inserted: number;
  provisions_skipped: number;
  enforcement_inserted: number;
  enforcement_skipped: number;
  errors: number;
}

const stats: Stats = {
  pages_fetched: 0,
  provisions_inserted: 0,
  provisions_skipped: 0,
  enforcement_inserted: 0,
  enforcement_skipped: 0,
  errors: 0,
};

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function logProgress(): void {
  log(
    `Progress — pages: ${stats.pages_fetched}, provisions: ${stats.provisions_inserted} inserted / ${stats.provisions_skipped} skipped, enforcement: ${stats.enforcement_inserted} inserted / ${stats.enforcement_skipped} skipped, errors: ${stats.errors}`,
  );
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage(url: string): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );

      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "de-CH,de;q=0.9,en;q=0.5",
        },
        signal: controller.signal,
        redirect: "follow",
      });

      clearTimeout(timeout);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }

      stats.pages_fetched++;
      return await res.text();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      log(
        `  Attempt ${attempt}/${MAX_RETRIES} failed for ${url}: ${lastError.message}`,
      );
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BACKOFF_MS * attempt);
      }
    }
  }

  stats.errors++;
  throw new Error(
    `Failed after ${MAX_RETRIES} attempts: ${url} — ${lastError?.message}`,
  );
}

async function throttle(): Promise<void> {
  await sleep(RATE_LIMIT_MS);
}

// ── Database bootstrap ──────────────────────────────────────────────────────

function initDb(): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (FLAG_FORCE && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    log(`Deleted existing database at ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

// ── Sourcebook definitions ──────────────────────────────────────────────────

interface SourcebookDef {
  id: string;
  name: string;
  description: string;
}

const SOURCEBOOKS: SourcebookDef[] = [
  {
    id: "FINMA_RUNDSCHREIBEN",
    name: "FINMA-Rundschreiben",
    description:
      "Konkretisierungen von Gesetzen und Verordnungen sowie Aufsichtspraxis der FINMA. Rundschreiben richten sich an beaufsichtigte Institute und beschreiben die Erwartungen der FINMA.",
  },
  {
    id: "FINMA_VERORDNUNGEN",
    name: "FINMA-Verordnungen",
    description:
      "Vom Bundesrat oder von der FINMA erlassene Verordnungen zum Vollzug der Finanzmarktgesetze (FIDLEG, FINMAG, BankG, KAG, VAG, GwG).",
  },
  {
    id: "FINMA_WEGLEITUNGEN",
    name: "FINMA-Wegleitungen",
    description:
      "Praktische Orientierungshilfen der FINMA zu spezifischen Themen. Wegleitungen sind nicht rechtsverbindlich, zeigen aber die aufsichtsrechtliche Erwartungshaltung auf.",
  },
  {
    id: "FINMA_AUFSICHTSMITTEILUNGEN",
    name: "FINMA-Aufsichtsmitteilungen",
    description:
      "Mitteilungen der FINMA zu aktuellen aufsichtsrechtlichen Themen, Praxisänderungen und Erwartungen an die Beaufsichtigten.",
  },
  {
    id: "FINMA_GESETZE",
    name: "Finanzmarktgesetze",
    description:
      "Bundesgesetze zur Regulierung des schweizerischen Finanzmarktes: FINMAG, BankG, VAG, BEHG/FinfraG, KAG, FIDLEG, FINIG, GwG.",
  },
];

function ensureSourcebooks(db: Database.Database): void {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO sourcebooks (id, name, description) VALUES (?, ?, ?)",
  );
  for (const sb of SOURCEBOOKS) {
    insert.run(sb.id, sb.name, sb.description);
  }
  log(`Sourcebooks ensured (${SOURCEBOOKS.length} categories)`);
}

// ── Provision insert helpers ────────────────────────────────────────────────

interface ProvisionInput {
  sourcebook_id: string;
  reference: string;
  title: string;
  text: string;
  type: string;
  status: string;
  effective_date: string | null;
  chapter: string | null;
  section: string | null;
}

function buildProvisionInserter(db: Database.Database) {
  const check = db.prepare(
    "SELECT 1 FROM provisions WHERE sourcebook_id = ? AND reference = ? LIMIT 1",
  );
  const insert = db.prepare(`
    INSERT INTO provisions (sourcebook_id, reference, title, text, type, status, effective_date, chapter, section)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return function insertProvision(p: ProvisionInput): boolean {
    if (FLAG_RESUME) {
      const existing = check.get(p.sourcebook_id, p.reference);
      if (existing) {
        stats.provisions_skipped++;
        return false;
      }
    }

    if (FLAG_DRY_RUN) {
      log(`  [DRY-RUN] Would insert: ${p.reference} — ${p.title}`);
      stats.provisions_inserted++;
      return true;
    }

    insert.run(
      p.sourcebook_id,
      p.reference,
      p.title,
      p.text,
      p.type,
      p.status,
      p.effective_date,
      p.chapter,
      p.section,
    );
    stats.provisions_inserted++;
    return true;
  };
}

// ── Enforcement insert helpers ──────────────────────────────────────────────

interface EnforcementInput {
  firm_name: string;
  reference_number: string | null;
  action_type: string | null;
  amount: number | null;
  date: string | null;
  summary: string;
  sourcebook_references: string | null;
}

function buildEnforcementInserter(db: Database.Database) {
  const check = db.prepare(
    "SELECT 1 FROM enforcement_actions WHERE firm_name = ? AND date = ? LIMIT 1",
  );
  const insert = db.prepare(`
    INSERT INTO enforcement_actions (firm_name, reference_number, action_type, amount, date, summary, sourcebook_references)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  return function insertEnforcement(e: EnforcementInput): boolean {
    if (FLAG_RESUME) {
      const existing = check.get(e.firm_name, e.date);
      if (existing) {
        stats.enforcement_skipped++;
        return false;
      }
    }

    if (FLAG_DRY_RUN) {
      log(`  [DRY-RUN] Would insert enforcement: ${e.firm_name} (${e.date})`);
      stats.enforcement_inserted++;
      return true;
    }

    insert.run(
      e.firm_name,
      e.reference_number,
      e.action_type,
      e.amount,
      e.date,
      e.summary,
      e.sourcebook_references,
    );
    stats.enforcement_inserted++;
    return true;
  };
}

// ── Rundschreiben archive crawler ───────────────────────────────────────────
//
// FINMA archive pages at /de/dokumentation/archiv/rundschreiben/archiv-YYYY/
// contain static HTML listings of circulars. Each entry has:
//   - Title (accordion header)
//   - Description text
//   - PDF links with dates and file sizes
//   - Language variants (DE, FR, IT, EN)
//
// The current circulars page uses JS rendering, so we also crawl archive
// years and supplement with a known-circulars registry for current ones.

const ARCHIVE_YEARS = [
  2008, 2009, 2010, 2011, 2012, 2013, 2015, 2016, 2017, 2018, 2019, 2020,
];

/** Circulars on the current (non-archive) page are JS-rendered. We define
 *  the known current circulars here so the crawler can fetch their PDFs. */
const CURRENT_CIRCULARS: Array<{
  ref: string;
  title: string;
  pdfPath: string;
  date: string;
}> = [
  {
    ref: "RS 2023/1",
    title: "Operationelle Risiken und Resilienz – Banken",
    pdfPath:
      "/de/~/media/finma/dokumente/dokumentencenter/myfinma/rundschreiben/finma-rs-2023-01-20221207.pdf",
    date: "2024-01-01",
  },
  {
    ref: "RS 2024/1",
    title: "Eigenmittel – Banken",
    pdfPath:
      "/de/~/media/finma/dokumente/dokumentencenter/myfinma/rundschreiben/finma-rs-2024-01.pdf",
    date: "2025-01-01",
  },
  {
    ref: "RS 2024/2",
    title: "Liquidität – Banken",
    pdfPath:
      "/de/~/media/finma/dokumente/dokumentencenter/myfinma/rundschreiben/finma-rs-2024-02.pdf",
    date: "2025-01-01",
  },
  {
    ref: "RS 2024/3",
    title: "Risikoverteilung – Banken",
    pdfPath:
      "/de/~/media/finma/dokumente/dokumentencenter/myfinma/rundschreiben/finma-rs-2024-03.pdf",
    date: "2025-01-01",
  },
  {
    ref: "RS 2024/4",
    title: "Offenlegung – Banken",
    pdfPath:
      "/de/~/media/finma/dokumente/dokumentencenter/myfinma/rundschreiben/finma-rs-2024-04.pdf",
    date: "2025-01-01",
  },
  {
    ref: "RS 2024/5",
    title: "Zinsrisiken – Banken",
    pdfPath:
      "/de/~/media/finma/dokumente/dokumentencenter/myfinma/rundschreiben/finma-rs-2024-05.pdf",
    date: "2025-01-01",
  },
  {
    ref: "RS 2016/7",
    title: "Video- und Online-Identifizierung",
    pdfPath:
      "/de/~/media/finma/dokumente/dokumentencenter/myfinma/rundschreiben/finma-rs-2016-07-20210506.pdf",
    date: "2016-03-18",
  },
];

/** Known Aufsichtsmitteilungen (guidance notices) — PDF-based, not in HTML listings. */
const KNOWN_GUIDANCE: Array<{
  ref: string;
  title: string;
  pdfPath: string;
  date: string;
}> = [
  {
    ref: "AM 01/2024",
    title: "Cyber-Risiken",
    pdfPath:
      "/de/~/media/finma/dokumente/dokumentencenter/myfinma/4dokumentation/finma-aufsichtsmitteilungen/20240202-finma-aufsichtsmitteilung-01-2024.pdf",
    date: "2024-02-02",
  },
  {
    ref: "AM 02/2023",
    title: "Naturkatastrophen und Klimarisiken",
    pdfPath:
      "/de/~/media/finma/dokumente/dokumentencenter/myfinma/4dokumentation/finma-aufsichtsmitteilungen/20230130-finma-aufsichtsmitteilung-02-2023.pdf",
    date: "2023-01-30",
  },
  {
    ref: "AM 03/2024",
    title: "Aufsicht und Risikomanagement",
    pdfPath:
      "/de/~/media/finma/dokumente/dokumentencenter/myfinma/4dokumentation/finma-aufsichtsmitteilungen/20160707-finma-aufsichtsmitteilung-03-2024.pdf",
    date: "2024-07-07",
  },
  {
    ref: "AM 05/2020",
    title: "Cyber-Angriffe: Meldepflicht gemäss FINMA-Aufsichtsmitteilung 05/2020",
    pdfPath:
      "/de/~/media/finma/dokumente/dokumentencenter/myfinma/4dokumentation/finma-aufsichtsmitteilungen/20200507-finma-aufsichtsmitteilung-05-2020.pdf",
    date: "2020-05-07",
  },
  {
    ref: "AM 05/2023",
    title: "Risikoanalyse und Risikomanagement",
    pdfPath:
      "/de/~/media/finma/dokumente/dokumentencenter/myfinma/4dokumentation/finma-aufsichtsmitteilungen/20230824-finma-aufsichtsmitteilung-05-2023.pdf",
    date: "2023-08-24",
  },
  {
    ref: "AM 05/2025",
    title: "Operationelle Resilienz",
    pdfPath:
      "/de/~/media/finma/dokumente/dokumentencenter/myfinma/4dokumentation/finma-aufsichtsmitteilungen/20251110-finma-aufsichtsmitteilung-05-2025.pdf",
    date: "2025-11-10",
  },
  {
    ref: "AM 08/2024",
    title: "Aufsichtstätigkeit und Schwerpunkte",
    pdfPath:
      "/de/~/media/finma/dokumente/dokumentencenter/myfinma/4dokumentation/finma-aufsichtsmitteilungen/20241218-finma-aufsichtsmitteilung-08-2024.pdf",
    date: "2024-12-18",
  },
  {
    ref: "AM 02/2025",
    title: "Aufsichtstätigkeit",
    pdfPath:
      "/de/~/media/finma/dokumente/dokumentencenter/myfinma/4dokumentation/finma-aufsichtsmitteilungen/20250522-finma-aufsichtsmitteilung-02-2025.pdf",
    date: "2025-05-22",
  },
  {
    ref: "AM 01/2016",
    title: "Finanzmarktinfrastrukturgesetz (FinfraG)",
    pdfPath:
      "/de/~/media/finma/dokumente/dokumentencenter/myfinma/4dokumentation/finma-aufsichtsmitteilungen/20160707-finma-aufsichtsmitteilung-01-2016.pdf",
    date: "2016-07-07",
  },
];

/**
 * Parse a Rundschreiben archive page for circular entries.
 *
 * Archive pages (archiv-YYYY) use accordion-style sections. Each circular
 * appears as an <article> or <div> with:
 *   - A heading containing the RS number + title
 *   - Description text
 *   - One or more PDF download links
 */
function parseArchivePage(
  html: string,
  archiveYear: number,
): ProvisionInput[] {
  const $ = cheerio.load(html);
  const results: ProvisionInput[] = [];

  // FINMA archive pages use .mod-download or .download-list items.
  // Each circular section has a heading and one or more PDF links.
  // We extract from the accordion/article structure.

  // Strategy 1: look for titled sections with PDF links
  $(".mod-accordion__item, .mod-download, article, .l-content-main .mod-text").each(
    (_i, el) => {
      const $el = $(el);
      const heading =
        $el.find("h2, h3, h4, .mod-accordion__title, .mod-download__title").first().text().trim() ||
        $el.find("a").first().text().trim();

      if (!heading) return;

      // Try to extract RS reference from heading (e.g. "2017/01" or "RS 2017/1")
      const refMatch = heading.match(
        /(?:RS\s*)?(\d{4})\/(\d{1,2})/i,
      );

      // Also look for references in the broader text
      const fullText = $el.text();
      const altRefMatch = fullText.match(
        /FINMA-Rundschreiben\s+(\d{4})\/(\d{1,2})/i,
      );

      const match = refMatch ?? altRefMatch;
      if (!match) return;

      const year = match[1]!;
      const num = match[2]!.padStart(2, "0");
      const reference = `RS ${year}/${num}`;

      // Extract description
      const descEl = $el.find("p, .mod-download__text, .mod-accordion__content p");
      const description = descEl
        .map((_j, p) => $(p).text().trim())
        .get()
        .filter((t) => t.length > 20)
        .join(" ");

      // Extract the most recent PDF link for the German version
      let pdfUrl: string | null = null;
      $el.find('a[href*=".pdf"]').each((_j, a) => {
        const href = $(a).attr("href");
        if (href && (href.includes("_de") || href.includes("sc_lang=de") || !pdfUrl)) {
          pdfUrl = href;
        }
      });

      // Extract date from link text or heading
      const dateMatch = fullText.match(
        /(\d{2})\.(\d{2})\.(\d{4})/,
      );
      let effectiveDate: string | null = null;
      if (dateMatch) {
        effectiveDate = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
      }

      // Clean up title: remove "FINMA-Rundschreiben" prefix if present
      let title = heading
        .replace(/FINMA-Rundschreiben\s*/i, "")
        .replace(/^\d{4}\/\d{1,2}\s*/, "")
        .replace(/^["«»"]\s*/, "")
        .replace(/\s*["«»"]$/, "")
        .trim();

      if (!title || title.length < 3) {
        title = heading.trim();
      }
      title = `FINMA-RS ${year}/${num} — ${title}`;

      const text =
        description.length > 30
          ? description
          : `FINMA-Rundschreiben ${reference}: ${title}. Veröffentlicht im Archiv ${archiveYear}.`;

      results.push({
        sourcebook_id: "FINMA_RUNDSCHREIBEN",
        reference,
        title,
        text,
        type: "Rundschreiben",
        status: "deleted", // archive = superseded/deleted
        effective_date: effectiveDate,
        chapter: null,
        section: null,
      });
    },
  );

  // Strategy 2: fall back to scanning all links for RS patterns
  if (results.length === 0) {
    const seenRefs = new Set<string>();

    $("a").each((_i, a) => {
      const href = $(a).attr("href") ?? "";
      const linkText = $(a).text().trim();
      const combined = `${linkText} ${href}`;

      // Match RS references in link text or URL paths like rs-17-01
      const textMatch = combined.match(/(?:RS\s*)?(\d{4})\/(\d{1,2})/i);
      const urlMatch = href.match(/rs-(\d{2})-(\d{2})/);

      let year: string | undefined;
      let num: string | undefined;

      if (textMatch) {
        year = textMatch[1];
        num = textMatch[2]?.padStart(2, "0");
      } else if (urlMatch) {
        const shortYear = urlMatch[1]!;
        year = parseInt(shortYear, 10) > 50
          ? `19${shortYear}`
          : `20${shortYear}`;
        num = urlMatch[2];
      }

      if (!year || !num) return;
      const reference = `RS ${year}/${num}`;
      if (seenRefs.has(reference)) return;
      seenRefs.add(reference);

      // Walk up to find surrounding text for the title
      const parentText = $(a).closest("div, li, td, article").text().trim();
      const titleSnippet = linkText.length > 5 ? linkText : parentText.slice(0, 200);

      let cleanTitle = titleSnippet
        .replace(/FINMA-Rundschreiben\s*/gi, "")
        .replace(/\d{4}\/\d{1,2}\s*/g, "")
        .replace(/["«»"]/g, "")
        .split("\n")[0]!
        .trim();

      if (cleanTitle.length < 3) {
        cleanTitle = `Rundschreiben ${reference}`;
      }

      results.push({
        sourcebook_id: "FINMA_RUNDSCHREIBEN",
        reference,
        title: `FINMA-RS ${year}/${num} — ${cleanTitle}`,
        text: `FINMA-Rundschreiben ${reference}: ${cleanTitle}. Archiviert.`,
        type: "Rundschreiben",
        status: "deleted",
        effective_date: null,
        chapter: null,
        section: null,
      });
    });
  }

  return results;
}

async function crawlRundschreibenArchives(
  insertProvision: (p: ProvisionInput) => boolean,
): Promise<void> {
  log("--- Crawling Rundschreiben archives ---");

  for (const year of ARCHIVE_YEARS) {
    const url = `${BASE_URL}/de/dokumentation/archiv/rundschreiben/archiv-${year}/`;
    log(`Fetching archive ${year}: ${url}`);

    try {
      const html = await fetchPage(url);
      const provisions = parseArchivePage(html, year);

      log(`  Found ${provisions.length} circulars in archive ${year}`);

      for (const p of provisions) {
        insertProvision(p);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  ERROR crawling archive ${year}: ${msg}`);
      stats.errors++;
    }

    await throttle();
  }
}

// ── Current circulars (from registry) ───────────────────────────────────────

async function ingestCurrentCirculars(
  insertProvision: (p: ProvisionInput) => boolean,
): Promise<void> {
  log("--- Ingesting current FINMA circulars ---");

  for (const circ of CURRENT_CIRCULARS) {
    const pdfUrl = `${BASE_URL}${circ.pdfPath}`;
    log(`  Fetching current circular: ${circ.ref} — ${circ.title}`);

    try {
      // We fetch the PDF to verify it exists, but we do not parse PDF content
      // (that requires a PDF parser). Instead, we record the circular metadata.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const res = await fetch(pdfUrl, {
        method: "HEAD",
        headers: { "User-Agent": USER_AGENT },
        signal: controller.signal,
        redirect: "follow",
      });

      clearTimeout(timeout);

      if (!res.ok) {
        log(`  WARNING: PDF not accessible (HTTP ${res.status}): ${pdfUrl}`);
      }
      stats.pages_fetched++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  WARNING: Could not verify PDF for ${circ.ref}: ${msg}`);
    }

    insertProvision({
      sourcebook_id: "FINMA_RUNDSCHREIBEN",
      reference: circ.ref,
      title: `FINMA-${circ.ref} — ${circ.title}`,
      text: `FINMA-Rundschreiben ${circ.ref}: ${circ.title}. Aktuell gültig. PDF verfügbar unter ${BASE_URL}${circ.pdfPath}`,
      type: "Rundschreiben",
      status: "in_force",
      effective_date: circ.date,
      chapter: null,
      section: null,
    });

    await throttle();
  }
}

// ── Aufsichtsmitteilungen (guidance notices) ────────────────────────────────

async function ingestGuidanceNotices(
  insertProvision: (p: ProvisionInput) => boolean,
): Promise<void> {
  log("--- Ingesting FINMA Aufsichtsmitteilungen ---");

  for (const am of KNOWN_GUIDANCE) {
    const pdfUrl = `${BASE_URL}${am.pdfPath}`;
    log(`  Fetching guidance: ${am.ref} — ${am.title}`);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const res = await fetch(pdfUrl, {
        method: "HEAD",
        headers: { "User-Agent": USER_AGENT },
        signal: controller.signal,
        redirect: "follow",
      });

      clearTimeout(timeout);

      if (!res.ok) {
        log(`  WARNING: PDF not accessible (HTTP ${res.status}): ${pdfUrl}`);
      }
      stats.pages_fetched++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  WARNING: Could not verify PDF for ${am.ref}: ${msg}`);
    }

    insertProvision({
      sourcebook_id: "FINMA_AUFSICHTSMITTEILUNGEN",
      reference: am.ref,
      title: `FINMA-Aufsichtsmitteilung ${am.ref} — ${am.title}`,
      text: `FINMA-Aufsichtsmitteilung ${am.ref}: ${am.title}. Veröffentlicht am ${am.date}. PDF verfügbar unter ${pdfUrl}`,
      type: "Aufsichtsmitteilung",
      status: "in_force",
      effective_date: am.date,
      chapter: null,
      section: null,
    });

    await throttle();
  }
}

// ── Legal basis / Verordnungen crawler ──────────────────────────────────────
//
// FINMA's legal basis page at /de/dokumentation/rechtliche-grundlagen/
// lists laws and ordinances organized by sector (banks, insurers, etc.).
// The sector sub-pages have static HTML with links to Fedlex (SR numbers).

const LEGAL_BASIS_PAGES: Array<{
  url: string;
  sector: string;
}> = [
  {
    url: "/de/dokumentation/rechtliche-grundlagen/gesetze-und-verordnungen/banken/",
    sector: "Banken",
  },
  {
    url: "/de/dokumentation/rechtliche-grundlagen/gesetze-und-verordnungen/versicherungen/",
    sector: "Versicherungen",
  },
  {
    url: "/de/dokumentation/rechtliche-grundlagen/gesetze-und-verordnungen/finma/",
    sector: "FINMA",
  },
  {
    url: "/de/dokumentation/rechtliche-grundlagen/gesetze-und-verordnungen/finanzinstitute/",
    sector: "Finanzinstitute",
  },
  {
    url: "/de/dokumentation/rechtliche-grundlagen/gesetze-und-verordnungen/kollektive-kapitalanlagen/",
    sector: "Kollektive Kapitalanlagen",
  },
  {
    url: "/de/dokumentation/rechtliche-grundlagen/gesetze-und-verordnungen/finanzdienstleistungen/",
    sector: "Finanzdienstleistungen",
  },
  {
    url: "/de/dokumentation/rechtliche-grundlagen/gesetze-und-verordnungen/finanzmarktinfrastrukturen/",
    sector: "Finanzmarktinfrastrukturen",
  },
  {
    url: "/de/dokumentation/rechtliche-grundlagen/gesetze-und-verordnungen/geldwaescherei/",
    sector: "Geldwäscherei",
  },
];

function parseLegalBasisPage(
  html: string,
  sector: string,
): ProvisionInput[] {
  const $ = cheerio.load(html);
  const results: ProvisionInput[] = [];
  const seenRefs = new Set<string>();

  // Legal basis pages list laws/ordinances as links, often to fedlex.admin.ch.
  // Each entry typically has:
  //   - Title (law name)
  //   - SR number (e.g. SR 952.0)
  //   - Link to Fedlex

  $("a").each((_i, a) => {
    const $a = $(a);
    const text = $a.text().trim();
    const href = $a.attr("href") ?? "";

    // Skip navigation links, anchors, non-law links
    if (
      !text ||
      text.length < 5 ||
      href.startsWith("#") ||
      href.includes("finma.ch/de/finma") ||
      href.includes("finma.ch/de/news") ||
      text.toLowerCase().includes("mehr erfahren") ||
      text.toLowerCase().includes("weitere informationen")
    ) {
      return;
    }

    // Detect SR numbers
    const srMatch = text.match(/SR\s*(\d{3}\.\d[\w.]*)/i) ??
      href.match(/\/(\d{3}\.\d[\w.]*)/);

    // Detect law/ordinance names
    const isLaw = /gesetz|verordnung|ordonnance|loi|reglement/i.test(text);
    const isFedlex = href.includes("fedlex.data.admin.ch") || href.includes("admin.ch/opc");

    if (!isLaw && !isFedlex) return;

    const srNum = srMatch ? `SR ${srMatch[1]}` : null;
    const reference = srNum ?? text.slice(0, 80);

    if (seenRefs.has(reference)) return;
    seenRefs.add(reference);

    // Determine if this is a Gesetz (law) or Verordnung (ordinance)
    const isVerordnung = /verordnung|ordonnance/i.test(text);
    const sourcebookId = isVerordnung ? "FINMA_VERORDNUNGEN" : "FINMA_GESETZE";
    const type = isVerordnung ? "Verordnung" : "Bundesgesetz";

    results.push({
      sourcebook_id: sourcebookId,
      reference,
      title: text,
      text: `${text}. Sektor: ${sector}. ${srNum ? `Systematische Rechtssammlung: ${srNum}.` : ""} ${isFedlex ? `Fedlex: ${href}` : ""}`.trim(),
      type,
      status: "in_force",
      effective_date: null,
      chapter: sector,
      section: null,
    });
  });

  return results;
}

async function crawlLegalBasis(
  insertProvision: (p: ProvisionInput) => boolean,
): Promise<void> {
  log("--- Crawling legal basis pages ---");

  for (const page of LEGAL_BASIS_PAGES) {
    const url = `${BASE_URL}${page.url}`;
    log(`Fetching legal basis (${page.sector}): ${url}`);

    try {
      const html = await fetchPage(url);
      const provisions = parseLegalBasisPage(html, page.sector);

      log(`  Found ${provisions.length} laws/ordinances for ${page.sector}`);

      for (const p of provisions) {
        insertProvision(p);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  ERROR crawling legal basis ${page.sector}: ${msg}`);
      stats.errors++;
    }

    await throttle();
  }
}

// ── Enforcement bulletin crawler ────────────────────────────────────────────
//
// FINMA publishes enforcement bulletins (PDF) with selected rulings.
// The selected-rulings page lists bulletin PDFs by year. We parse the
// HTML listing to extract bulletin metadata and create enforcement entries.

async function crawlEnforcementBulletins(
  insertEnforcement: (e: EnforcementInput) => boolean,
): Promise<void> {
  log("--- Crawling enforcement bulletins ---");

  const url = `${BASE_URL}/de/dokumentation/enforcement-reporting/ausgewaehlte-verfuegungen/`;
  const altUrl = `${BASE_URL}/en/documentation/enforcement-reporting/selected-finma-rulings/`;

  let html: string;
  try {
    html = await fetchPage(url);
  } catch {
    log("  German URL failed, trying English URL...");
    try {
      html = await fetchPage(altUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  ERROR: Could not fetch enforcement rulings page: ${msg}`);
      stats.errors++;
      return;
    }
  }

  const $ = cheerio.load(html);

  // Extract bulletin PDF links and metadata
  $("a[href*='.pdf']").each((_i, a) => {
    const $a = $(a);
    const text = $a.text().trim();
    const href = $a.attr("href") ?? "";

    if (!text || text.length < 5) return;

    // Look for enforcement-specific content: bulletin PDFs
    const isBulletin =
      /bulletin|enforcement|verfügung|massnahme/i.test(text) ||
      href.includes("bulletin") ||
      href.includes("enforcement");

    if (!isBulletin) return;

    // Extract date from link text or parent
    const dateMatch = text.match(/(\d{2})\.(\d{2})\.(\d{4})/) ??
      $a.closest("div, li, td").text().match(/(\d{2})\.(\d{2})\.(\d{4})/);

    const date = dateMatch
      ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`
      : null;

    insertEnforcement({
      firm_name: `FINMA Enforcement Bulletin`,
      reference_number: text.slice(0, 100),
      action_type: "bulletin",
      amount: null,
      date,
      summary: `${text}. PDF: ${href.startsWith("http") ? href : BASE_URL + href}`,
      sourcebook_references: null,
    });
  });

  // Also extract any inline case summaries from the page text
  $(".mod-accordion__item, article, .l-content-main section").each((_i, el) => {
    const $el = $(el);
    const heading = $el.find("h2, h3, h4").first().text().trim();
    const body = $el.find("p").text().trim();

    if (!heading || body.length < 50) return;

    // Look for firm names or case references
    const firmMatch = heading.match(
      /(?:gegen|vs\.?|betreffend)\s+(.+?)(?:\s*[-–—]|\s*\(|$)/i,
    );
    const firmName = firmMatch ? firmMatch[1]!.trim() : heading;

    const dateMatch = body.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    const date = dateMatch
      ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`
      : null;

    // Determine action type
    let actionType = "ruling";
    if (/entzug|withdrawal|licence/i.test(body)) {
      actionType = "licence_withdrawal";
    } else if (/verbot|ban|prohibition/i.test(body)) {
      actionType = "ban";
    } else if (/busse|fine|sanktion/i.test(body)) {
      actionType = "fine";
    } else if (/einschränkung|restriction|massnahme/i.test(body)) {
      actionType = "restriction";
    }

    insertEnforcement({
      firm_name: firmName,
      reference_number: null,
      action_type: actionType,
      amount: null,
      date,
      summary: body.slice(0, 2000),
      sourcebook_references: null,
    });
  });

  await throttle();
}

// ── Recovery/resolution proceedings crawler ─────────────────────────────────
//
// FINMA publishes ongoing and completed insolvency/resolution proceedings at
// /de/enforcement/sanierung-und-insolvenz/publikationen/verfahren/.
// These pages list firms under bankruptcy/liquidation/protective measures.

const ENFORCEMENT_PROCEEDINGS_PAGES = [
  {
    url: "/de/enforcement/sanierung-und-insolvenz/publikationen/verfahren/",
    category: "Sanierung und Insolvenz",
  },
  {
    url: "/de/enforcement/sanierung-und-insolvenz/publikationen/verfahren/abgeschlossene-verfahren/",
    category: "Abgeschlossene Verfahren",
  },
];

function parseEnforcementProceedings(
  html: string,
  category: string,
): EnforcementInput[] {
  const $ = cheerio.load(html);
  const results: EnforcementInput[] = [];
  const seenFirms = new Set<string>();

  // Look for firm names in links, headings, and list items
  $("a, h2, h3, h4, li").each((_i, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    const href = $el.attr("href") ?? "";

    if (!text || text.length < 3) return;

    // Skip navigation links
    if (
      /^(Home|Enforcement|FINMA|Suche|Kontakt|Medien|Seite|Mehr|Weitere)/i.test(
        text,
      )
    ) {
      return;
    }

    // Look for entity names (typically contain AG, SA, Ltd, GmbH, etc.)
    const isFirm =
      /\b(AG|SA|Ltd|GmbH|Inc|Corp|S\.A\.|Sàrl|Bank|Stiftung|Genossenschaft)\b/i.test(
        text,
      ) ||
      (href.includes("/verfahren/") &&
        !href.includes("publikationen/verfahren/") &&
        text.length < 200);

    if (!isFirm) return;

    const firmName = text.replace(/\s+/g, " ").slice(0, 200);
    if (seenFirms.has(firmName)) return;
    seenFirms.add(firmName);

    // Try to find a date nearby
    const parentText = $el.closest("div, li, td, article").text();
    const dateMatch = parentText.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    const date = dateMatch
      ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`
      : null;

    // Determine action type from context
    let actionType = "proceeding";
    if (/konkurs|bankruptcy|insolvenz/i.test(parentText)) {
      actionType = "bankruptcy";
    } else if (/liquidation/i.test(parentText)) {
      actionType = "liquidation";
    } else if (/sanierung|recovery|restructuring/i.test(parentText)) {
      actionType = "recovery";
    } else if (/schutzmassnahme|protective/i.test(parentText)) {
      actionType = "protective_measure";
    }

    results.push({
      firm_name: firmName,
      reference_number: null,
      action_type: actionType,
      amount: null,
      date,
      summary: `${category}: ${firmName}. ${parentText.slice(0, 500)}`.trim(),
      sourcebook_references: null,
    });
  });

  return results;
}

async function crawlEnforcementProceedings(
  insertEnforcement: (e: EnforcementInput) => boolean,
): Promise<void> {
  log("--- Crawling enforcement proceedings ---");

  for (const page of ENFORCEMENT_PROCEEDINGS_PAGES) {
    const url = `${BASE_URL}${page.url}`;
    log(`Fetching enforcement proceedings (${page.category}): ${url}`);

    try {
      const html = await fetchPage(url);
      const proceedings = parseEnforcementProceedings(html, page.category);

      log(
        `  Found ${proceedings.length} proceedings in ${page.category}`,
      );

      for (const e of proceedings) {
        insertEnforcement(e);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  ERROR crawling enforcement proceedings: ${msg}`);
      stats.errors++;
    }

    await throttle();
  }
}

// ── News / press releases for enforcement actions ───────────────────────────
//
// FINMA announces major enforcement actions via press releases at
// /de/news/. We crawl the news listing for enforcement-related releases.

async function crawlEnforcementNews(
  insertEnforcement: (e: EnforcementInput) => boolean,
): Promise<void> {
  log("--- Crawling enforcement-related news ---");

  // The news page is JS-rendered, but older enforcement pages are static.
  // We crawl known enforcement dossier pages that have static content.
  const dossierUrls = [
    "/de/dokumentation/dossier/dossier-geldwaeschereibekaempfung/",
    "/de/dokumentation/dossier/dossier-credit-suisse/",
  ];

  for (const path of dossierUrls) {
    const url = `${BASE_URL}${path}`;
    log(`Fetching enforcement dossier: ${url}`);

    try {
      const html = await fetchPage(url);
      const $ = cheerio.load(html);

      // Extract enforcement cases from dossier pages
      $("a").each((_i, a) => {
        const $a = $(a);
        const text = $a.text().trim();
        const href = $a.attr("href") ?? "";

        // Look for enforcement-related links
        if (
          !/enforcement|verfahren|verfügung|massnahme/i.test(text + href)
        ) {
          return;
        }

        if (text.length < 10 || text.length > 500) return;

        const dateMatch = text.match(/(\d{2})\.(\d{2})\.(\d{4})/) ??
          text.match(/\((\d{4})\)/);

        let date: string | null = null;
        if (dateMatch && dateMatch[3]) {
          date = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
        } else if (dateMatch && dateMatch[1] && !dateMatch[2]) {
          date = `${dateMatch[1]}-01-01`;
        }

        insertEnforcement({
          firm_name: text.slice(0, 200),
          reference_number: null,
          action_type: "enforcement_dossier",
          amount: null,
          date,
          summary: text,
          sourcebook_references: null,
        });
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  ERROR crawling dossier: ${msg}`);
      stats.errors++;
    }

    await throttle();
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log("=== FINMA Ingestion Crawler ===");
  log(`Database: ${DB_PATH}`);
  log(
    `Flags: resume=${FLAG_RESUME}, dry-run=${FLAG_DRY_RUN}, force=${FLAG_FORCE}`,
  );

  // Verify cheerio import
  if (!cheerio.load) {
    throw new Error(
      "cheerio not available. Install with: npm install cheerio @types/cheerio",
    );
  }

  const db = FLAG_DRY_RUN ? null : initDb();

  if (db) {
    ensureSourcebooks(db);
  } else {
    log("[DRY-RUN] Skipping database initialization");
  }

  // Build inserters (use no-op DB for dry run)
  let dryDb: Database.Database | null = null;
  if (FLAG_DRY_RUN) {
    // Create in-memory DB for dry-run schema validation
    dryDb = new Database(":memory:");
    dryDb.pragma("journal_mode = WAL");
    dryDb.exec(SCHEMA_SQL);
    for (const sb of SOURCEBOOKS) {
      dryDb
        .prepare(
          "INSERT OR IGNORE INTO sourcebooks (id, name, description) VALUES (?, ?, ?)",
        )
        .run(sb.id, sb.name, sb.description);
    }
  }

  const activeDb = db ?? dryDb!;
  const insertProvision = buildProvisionInserter(activeDb);
  const insertEnforcement = buildEnforcementInserter(activeDb);

  // Wrap DB writes in a transaction for performance (unless dry-run)
  const runIngestion = async (): Promise<void> => {
    // Phase 1: Rundschreiben archives (static HTML)
    await crawlRundschreibenArchives(insertProvision);
    logProgress();

    // Phase 2: Current circulars (registry-based)
    await ingestCurrentCirculars(insertProvision);
    logProgress();

    // Phase 3: Aufsichtsmitteilungen (registry-based)
    await ingestGuidanceNotices(insertProvision);
    logProgress();

    // Phase 4: Legal basis / laws and ordinances
    await crawlLegalBasis(insertProvision);
    logProgress();

    // Phase 5: Enforcement bulletins (selected rulings)
    await crawlEnforcementBulletins(insertEnforcement);
    logProgress();

    // Phase 6: Enforcement proceedings (insolvency/resolution)
    await crawlEnforcementProceedings(insertEnforcement);
    logProgress();

    // Phase 7: Enforcement dossiers (news-based)
    await crawlEnforcementNews(insertEnforcement);
    logProgress();
  };

  // Async crawling with interleaved HTTP calls prevents wrapping
  // everything in a single better-sqlite3 transaction (which is
  // synchronous). Individual inserts are fast enough with WAL mode.
  await runIngestion();

  // ── Final summary ───────────────────────────────────────────────────────

  if (db) {
    const provisionCount = (
      db.prepare("SELECT count(*) as cnt FROM provisions").get() as {
        cnt: number;
      }
    ).cnt;
    const sourcebookCount = (
      db.prepare("SELECT count(*) as cnt FROM sourcebooks").get() as {
        cnt: number;
      }
    ).cnt;
    const enforcementCount = (
      db.prepare("SELECT count(*) as cnt FROM enforcement_actions").get() as {
        cnt: number;
      }
    ).cnt;
    const ftsCount = (
      db.prepare("SELECT count(*) as cnt FROM provisions_fts").get() as {
        cnt: number;
      }
    ).cnt;

    log("");
    log("=== Datenbank-Zusammenfassung ===");
    log(`  Publikationskategorien:  ${sourcebookCount}`);
    log(`  Bestimmungen:            ${provisionCount}`);
    log(`  Durchsetzungsmassnahmen: ${enforcementCount}`);
    log(`  FTS-Einträge:            ${ftsCount}`);

    db.close();
  }

  if (dryDb) {
    dryDb.close();
  }

  log("");
  log("=== Abschlussbericht ===");
  log(`  Seiten abgerufen:              ${stats.pages_fetched}`);
  log(`  Bestimmungen eingefügt:        ${stats.provisions_inserted}`);
  log(`  Bestimmungen übersprungen:     ${stats.provisions_skipped}`);
  log(`  Durchsetzungen eingefügt:      ${stats.enforcement_inserted}`);
  log(`  Durchsetzungen übersprungen:   ${stats.enforcement_skipped}`);
  log(`  Fehler:                        ${stats.errors}`);
  log("");

  if (stats.errors > 0) {
    log(
      `WARNING: ${stats.errors} error(s) occurred. Check logs above for details.`,
    );
  }

  if (FLAG_DRY_RUN) {
    log("Dry run complete. No data was written to disk.");
  } else {
    log(`Abgeschlossen. Datenbank bereit unter ${DB_PATH}`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
