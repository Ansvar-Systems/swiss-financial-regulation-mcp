/**
 * Seed the FINMA database with sample provisions for testing.
 *
 * Inserts well-known provisions from FINMA Rundschreiben, Verordnungen,
 * and Wegleitungen so MCP tools can be tested without a full data ingest.
 *
 * Primary language: German.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force   # drop and recreate
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["FINMA_DB_PATH"] ?? "data/finma.db";
const force = process.argv.includes("--force");

// ── Bootstrap database ───────────────────────────────────────────────────────

const dir = dirname(DB_PATH);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

if (force && existsSync(DB_PATH)) {
  unlinkSync(DB_PATH);
  console.log(`Existing database deleted at ${DB_PATH}`);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);

console.log(`Database initialised at ${DB_PATH}`);

// ── Sourcebooks (Publikationskategorien) ─────────────────────────────────────

interface SourcebookRow {
  id: string;
  name: string;
  description: string;
}

const sourcebooks: SourcebookRow[] = [
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
];

const insertSourcebook = db.prepare(
  "INSERT OR IGNORE INTO sourcebooks (id, name, description) VALUES (?, ?, ?)",
);

for (const sb of sourcebooks) {
  insertSourcebook.run(sb.id, sb.name, sb.description);
}

console.log(`Inserted ${sourcebooks.length} sourcebooks`);

// ── Sample provisions ────────────────────────────────────────────────────────

interface ProvisionRow {
  sourcebook_id: string;
  reference: string;
  title: string;
  text: string;
  type: string;
  status: string;
  effective_date: string;
  chapter: string;
  section: string;
}

const provisions: ProvisionRow[] = [
  // ── FINMA-Rundschreiben 2023/1 — Operationelle Risiken und Resilienz ────
  {
    sourcebook_id: "FINMA_RUNDSCHREIBEN",
    reference: "RS 2023/1 Rz 1",
    title: "FINMA-RS 2023/1 — Gegenstand und Zweck",
    text: "Dieses Rundschreiben konkretisiert die Anforderungen an das Management operationeller Risiken und die operationelle Resilienz von Banken gemäss Bankengesetz (BankG) und Bankenverordnung (BankV). Es legt fest, wie Banken ihre Systeme, Prozesse und Strukturen so ausgestalten müssen, dass kritische Dienstleistungen auch in Stresssituationen aufrechterhalten werden können.",
    type: "Rundschreiben",
    status: "in_force",
    effective_date: "2024-01-01",
    chapter: "I",
    section: "Gegenstand",
  },
  {
    sourcebook_id: "FINMA_RUNDSCHREIBEN",
    reference: "RS 2023/1 Rz 10",
    title: "FINMA-RS 2023/1 — Operationelle Resilienz: Grundsatz",
    text: "Banken müssen ihre kritischen Dienstleistungen identifizieren und sicherstellen, dass diese auch bei schwerwiegenden Betriebsstörungen innerhalb eines tolerierbaren Ausfallzeitfensters wieder erbracht werden können. Das Management der operationellen Resilienz umfasst die Identifikation kritischer Dienstleistungen, die Festlegung von Toleranzgrenzen für Störungen sowie die Umsetzung angemessener Massnahmen zur Gewährleistung der Resilienz.",
    type: "Rundschreiben",
    status: "in_force",
    effective_date: "2024-01-01",
    chapter: "II",
    section: "Operationelle Resilienz",
  },
  {
    sourcebook_id: "FINMA_RUNDSCHREIBEN",
    reference: "RS 2023/1 Rz 25",
    title: "FINMA-RS 2023/1 — IKT- und Cyberrisiken",
    text: "Banken müssen ein umfassendes IKT-Risikomanagement implementieren, das alle wesentlichen IKT-Risiken erfasst, bewertet und mit angemessenen Massnahmen begrenzt. Dies umfasst insbesondere den Schutz vor Cyberangriffen, die Sicherung kritischer Daten und Systeme sowie die Überwachung von Schwachstellen in der IT-Infrastruktur.",
    type: "Rundschreiben",
    status: "in_force",
    effective_date: "2024-01-01",
    chapter: "III",
    section: "IKT- und Cyberrisiken",
  },
  {
    sourcebook_id: "FINMA_RUNDSCHREIBEN",
    reference: "RS 2023/1 Rz 40",
    title: "FINMA-RS 2023/1 — Business Continuity Management",
    text: "Banken müssen ein wirksames Business Continuity Management (BCM) betreiben. Dieses muss Business-Continuity-Pläne (BCP) für alle kritischen Geschäftsfelder umfassen, die regelmässig getestet werden. Die BCPs müssen sicherstellen, dass die Bank ihre kritischen Dienstleistungen auch im Katastrophenfall aufrechterhalten kann.",
    type: "Rundschreiben",
    status: "in_force",
    effective_date: "2024-01-01",
    chapter: "IV",
    section: "Business Continuity Management",
  },

  // ── FINMA-Rundschreiben 2018/3 — Outsourcing ────────────────────────────
  {
    sourcebook_id: "FINMA_RUNDSCHREIBEN",
    reference: "RS 2018/3 Rz 1",
    title: "FINMA-RS 2018/3 — Auslagerung bei Banken und Versicherungen: Gegenstand",
    text: "Dieses Rundschreiben regelt die Anforderungen an die Auslagerung von Geschäftsbereichen durch Banken und Versicherungsunternehmen. Es konkretisiert die gesetzlichen Anforderungen an das Outsourcing und legt fest, welche Bereiche nicht ausgelagert werden dürfen (Kernfunktionen) sowie welche Sorgfaltspflichten bei der Auswahl und Überwachung von Drittanbietern gelten.",
    type: "Rundschreiben",
    status: "in_force",
    effective_date: "2018-01-01",
    chapter: "I",
    section: "Gegenstand",
  },
  {
    sourcebook_id: "FINMA_RUNDSCHREIBEN",
    reference: "RS 2018/3 Rz 10",
    title: "FINMA-RS 2018/3 — Nicht auslagerbare Kernfunktionen",
    text: "Die Geschäftsleitung und der Verwaltungsrat eines Instituts können ihre Leitungs-, Aufsichts- und Kontrollfunktionen nicht auslagern. Das Institut bleibt für alle ausgelagerten Tätigkeiten gegenüber der FINMA verantwortlich. Strategische Entscheidungen, das Gesamtrisikomanagement sowie die Compliance-Funktion in ihren Kernaufgaben dürfen nicht vollständig ausgelagert werden.",
    type: "Rundschreiben",
    status: "in_force",
    effective_date: "2018-01-01",
    chapter: "II",
    section: "Nicht auslagerbare Funktionen",
  },
  {
    sourcebook_id: "FINMA_RUNDSCHREIBEN",
    reference: "RS 2018/3 Rz 20",
    title: "FINMA-RS 2018/3 — Sorgfaltspflichten bei Auslagerungen",
    text: "Institute müssen bei der Auswahl eines Dienstleisters eine angemessene Sorgfaltsprüfung (Due Diligence) durchführen. Der Dienstleister muss die notwendigen Fähigkeiten, Ressourcen und Qualifikationen besitzen. Institute müssen die Leistung des Dienstleisters laufend überwachen und sicherstellen, dass der Dienstleister die regulatorischen Anforderungen einhält.",
    type: "Rundschreiben",
    status: "in_force",
    effective_date: "2018-01-01",
    chapter: "III",
    section: "Sorgfaltspflichten",
  },

  // ── FINMA-Rundschreiben 2017/1 — Corporate Governance ───────────────────
  {
    sourcebook_id: "FINMA_RUNDSCHREIBEN",
    reference: "RS 2017/1 Rz 1",
    title: "FINMA-RS 2017/1 — Corporate Governance bei Banken: Gegenstand",
    text: "Dieses Rundschreiben konkretisiert die Anforderungen an die Corporate Governance von Banken gemäss BankG und BankV. Es regelt die Zusammensetzung und Aufgaben des Verwaltungsrats und der Geschäftsleitung sowie die Anforderungen an das interne Kontrollsystem (IKS).",
    type: "Rundschreiben",
    status: "in_force",
    effective_date: "2017-07-01",
    chapter: "I",
    section: "Gegenstand",
  },
  {
    sourcebook_id: "FINMA_RUNDSCHREIBEN",
    reference: "RS 2017/1 Rz 15",
    title: "FINMA-RS 2017/1 — Aufgaben des Verwaltungsrats",
    text: "Der Verwaltungsrat ist für die Oberleitung, Aufsicht und Kontrolle der Gesellschaft verantwortlich. Er legt die strategische Ausrichtung fest, genehmigt die Risikopolitik und -toleranz und überwacht die Geschäftsleitung. Der Verwaltungsrat muss sicherstellen, dass ein wirksames internes Kontrollsystem vorhanden ist und dass das Unternehmen die regulatorischen Anforderungen einhält.",
    type: "Rundschreiben",
    status: "in_force",
    effective_date: "2017-07-01",
    chapter: "II",
    section: "Verwaltungsrat",
  },
  {
    sourcebook_id: "FINMA_RUNDSCHREIBEN",
    reference: "RS 2017/1 Rz 30",
    title: "FINMA-RS 2017/1 — Internes Kontrollsystem (IKS)",
    text: "Banken müssen über ein wirksames internes Kontrollsystem (IKS) verfügen, das alle wesentlichen Risiken erfasst und begrenzt. Das IKS umfasst die drei Verteidigungslinien (Three Lines of Defence): operative Kontrollen (1. Linie), Risikomanagement und Compliance (2. Linie) sowie die interne Revision (3. Linie).",
    type: "Rundschreiben",
    status: "in_force",
    effective_date: "2017-07-01",
    chapter: "III",
    section: "Internes Kontrollsystem",
  },

  // ── FINMA-Rundschreiben 2008/21 — Operationelle Risiken Banken ──────────
  {
    sourcebook_id: "FINMA_RUNDSCHREIBEN",
    reference: "RS 2008/21 Rz 1",
    title: "FINMA-RS 2008/21 — Operationelle Risiken bei Banken (Basel II): Gegenstand",
    text: "Dieses Rundschreiben (Vorgänger von RS 2023/1) konkretisiert die Anforderungen an das Management operationeller Risiken gemäss Basel II und den damit verbundenen schweizerischen Rechtsvorschriften. Es legt die Anforderungen an die Eigenmittelunterlegung operationeller Risiken (Basisindikatoransatz, Standardansatz, fortgeschrittene Messansätze) fest.",
    type: "Rundschreiben",
    status: "deleted",
    effective_date: "2008-01-01",
    chapter: "I",
    section: "Gegenstand",
  },

  // ── FINMA Geldwäschereiverordnung (GwV-FINMA) ───────────────────────────
  {
    sourcebook_id: "FINMA_VERORDNUNGEN",
    reference: "GwV Art. 1",
    title: "Geldwäschereiverordnung-FINMA — Gegenstand und Geltungsbereich",
    text: "Diese Verordnung regelt die Pflichten der Beaufsichtigten zur Bekämpfung der Geldwäscherei und der Terrorismusfinanzierung. Sie konkretisiert das Geldwäschereigesetz (GwG) und gilt für alle von der FINMA beaufsichtigten Finanzintermediäre, insbesondere Banken, Effektenhändler, Fondsleitungen und Versicherungsunternehmen.",
    type: "Verordnung",
    status: "in_force",
    effective_date: "2016-01-01",
    chapter: "1",
    section: "Allgemeine Bestimmungen",
  },
  {
    sourcebook_id: "FINMA_VERORDNUNGEN",
    reference: "GwV Art. 12",
    title: "Geldwäschereiverordnung-FINMA — Sorgfaltspflichten: Identifikation",
    text: "Der Finanzintermediär muss die Vertragspartei bei der Aufnahme der Geschäftsbeziehung identifizieren und die Identität anhand eines amtlichen Ausweisdokuments überprüfen. Bei juristischen Personen muss die wirtschaftlich berechtigte Person festgestellt werden, sofern der massgebende Schwellenwert überschritten wird.",
    type: "Verordnung",
    status: "in_force",
    effective_date: "2016-01-01",
    chapter: "2",
    section: "Sorgfaltspflichten",
  },
  {
    sourcebook_id: "FINMA_VERORDNUNGEN",
    reference: "GwV Art. 20",
    title: "Geldwäschereiverordnung-FINMA — Politisch exponierte Personen (PEP)",
    text: "Politisch exponierte Personen (PEP) und ihnen nahestehende Personen sind als erhöhte Risiken zu qualifizieren. Der Finanzintermediär muss bei Geschäftsbeziehungen mit PEP erhöhte Sorgfaltspflichten anwenden, insbesondere die Herkunft der Vermögenswerte klären und die Geschäftsbeziehung von der Geschäftsleitung genehmigen lassen.",
    type: "Verordnung",
    status: "in_force",
    effective_date: "2016-01-01",
    chapter: "3",
    section: "Erhöhte Sorgfaltspflichten",
  },
  {
    sourcebook_id: "FINMA_VERORDNUNGEN",
    reference: "GwV Art. 35",
    title: "Geldwäschereiverordnung-FINMA — Meldepflicht bei Verdacht",
    text: "Hegt der Finanzintermediär den begründeten Verdacht, dass Vermögenswerte im Zusammenhang mit Geldwäscherei, einer Vortat zur Geldwäscherei oder Terrorismusfinanzierung stehen, ist er zur Meldung an die Meldestelle für Geldwäscherei (MROS) verpflichtet. Bis zum Entscheid der MROS dürfen keine Vermögenswerte übertragen werden.",
    type: "Verordnung",
    status: "in_force",
    effective_date: "2016-01-01",
    chapter: "5",
    section: "Meldepflicht",
  },

  // ── FINMA-Wegleitung — Aufsicht über systemrelevante Banken ─────────────
  {
    sourcebook_id: "FINMA_WEGLEITUNGEN",
    reference: "WL-SIB 2023 Abschnitt 1",
    title: "Wegleitung Systemrelevante Banken — Einleitung",
    text: "Diese Wegleitung erläutert den aufsichtsrechtlichen Ansatz der FINMA gegenüber systemrelevanten Banken (SIB) in der Schweiz. Systemrelevante Banken sind Institute, deren Ausfall die Stabilität des schweizerischen Finanzsystems und die Schweizer Volkswirtschaft stark beeinträchtigen würde. Die Anforderungen an SIBs umfassen erhöhte Eigenmittel- und Liquiditätsanforderungen sowie Anforderungen an die Wiederherstellungs- und Abwicklungsplanung (Recovery and Resolution Planning).",
    type: "Wegleitung",
    status: "in_force",
    effective_date: "2023-06-01",
    chapter: "1",
    section: "Einleitung",
  },

  // ── FINMA-Aufsichtsmitteilung — Cybersicherheit ──────────────────────────
  {
    sourcebook_id: "FINMA_AUFSICHTSMITTEILUNGEN",
    reference: "AM 2024/01 Rz 1",
    title: "FINMA-Aufsichtsmitteilung 2024/1 — Cybersicherheit im Finanzsektor",
    text: "Die FINMA erwartet von allen Beaufsichtigten, dass sie angemessene Massnahmen zur Gewährleistung der Cybersicherheit ergreifen. Angesichts der zunehmenden Bedrohungslage durch Cyberangriffe müssen Institute ihre Cyberresilienz kontinuierlich stärken. Die FINMA wird die Einhaltung der Anforderungen aus RS 2023/1 im Rahmen der laufenden Aufsicht prüfen und bei Feststellung wesentlicher Mängel aufsichtsrechtliche Massnahmen einleiten.",
    type: "Aufsichtsmitteilung",
    status: "in_force",
    effective_date: "2024-03-01",
    chapter: "1",
    section: "Ausgangslage",
  },
];

const insertProvision = db.prepare(`
  INSERT INTO provisions (sourcebook_id, reference, title, text, type, status, effective_date, chapter, section)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertAll = db.transaction(() => {
  for (const p of provisions) {
    insertProvision.run(
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
  }
});

insertAll();

console.log(`Inserted ${provisions.length} sample provisions`);

// ── Sample enforcement actions ───────────────────────────────────────────────

interface EnforcementRow {
  firm_name: string;
  reference_number: string;
  action_type: string;
  amount: number | null;
  date: string;
  summary: string;
  sourcebook_references: string;
}

const enforcements: EnforcementRow[] = [
  {
    firm_name: "Credit Suisse AG",
    reference_number: "FINMA-2021/01",
    action_type: "restriction",
    amount: null,
    date: "2021-10-19",
    summary:
      "Die FINMA stellte im Zusammenhang mit dem Zusammenbruch von Archegos Capital Management schwere Verletzungen des Risikogesetzes fest. Credit Suisse hatte die Konzentrationsrisiken gegenüber dem Hedgefonds Archegos unzureichend bewirtschaftet. Die FINMA eröffnete ein Enforcement-Verfahren und ordnete wesentliche Verbesserungen im Risikomanagement an. Das Versagen kostete Credit Suisse rund 5,5 Milliarden USD an Verlusten.",
    sourcebook_references: "RS 2017/1 Rz 15, RS 2023/1 Rz 10",
  },
  {
    firm_name: "Credit Suisse AG",
    reference_number: "FINMA-2021/02",
    action_type: "restriction",
    amount: null,
    date: "2021-07-29",
    summary:
      "Im Zusammenhang mit dem Zusammenbruch des Lieferkettenfinanzierungsfonds Greensill Capital eröffnete die FINMA ein Enforcement-Verfahren gegen Credit Suisse Asset Management. Die FINMA stellte schwere Verletzungen des Anlagefondsgesetzes fest: Credit Suisse hatte Anleger irreführend über Risiken informiert und das Fondsmanagement mangelhaft ausgestaltet. Die Bank war verpflichtet, umfangreiche Sanierungsmassnahmen umzusetzen.",
    sourcebook_references: "RS 2018/3 Rz 10, RS 2017/1 Rz 30",
  },
  {
    firm_name: "BSI AG",
    reference_number: "FINMA-2016/01",
    action_type: "licence_withdrawal",
    amount: null,
    date: "2016-05-24",
    summary:
      "Die FINMA entzog der BSI AG die Banklizenz. Die BSI AG hatte schwere Verletzungen der Geldwäschereivorschriften begangen und war in den 1MDB-Skandal (1Malaysia Development Berhad) verwickelt. Das Institut hatte die Sorgfaltspflichten zur Bekämpfung der Geldwäscherei und die Anforderungen an das Management operationeller und rechtlicher Risiken in gravierendem Mass verletzt.",
    sourcebook_references: "GwV Art. 12, GwV Art. 20, GwV Art. 35",
  },
  {
    firm_name: "Falcon Private Bank AG",
    reference_number: "FINMA-2016/02",
    action_type: "restriction",
    amount: null,
    date: "2016-10-25",
    summary:
      "Die FINMA stellte im Zusammenhang mit dem 1MDB-Skandal schwere Geldwäschereiverstösse bei der Falcon Private Bank AG fest. Vermögenswerte von Hunderten von Millionen US-Dollar wurden über Konten bei der Falcon Bank an mutmasslich korruprte staatliche Funktionsträger aus Malaysia weitergeleitet. Die FINMA entzog Falcon Private Bank den Schweizer Banklizenz-Status und forderte umfangreiche Massnahmen.",
    sourcebook_references: "GwV Art. 12, GwV Art. 20",
  },
  {
    firm_name: "Julius Bär Gruppe AG",
    reference_number: "FINMA-2020/01",
    action_type: "restriction",
    amount: null,
    date: "2020-02-21",
    summary:
      "Die FINMA stellte schwere Verletzungen der Geldwäschereivorschriften bei der Julius Bär Gruppe AG fest. Das Institut hatte über Jahre hinweg unzureichende Sorgfaltspflichten bei Hochrisiko-Geschäftsbeziehungen und Transaktionen angewendet. Die FINMA erliess einen Enforcementbescheid und beauftragte einen unabhängigen Prüfbeauftragten zur Überwachung der Sanierungsmassnahmen.",
    sourcebook_references: "GwV Art. 12, GwV Art. 35",
  },
];

const insertEnforcement = db.prepare(`
  INSERT INTO enforcement_actions (firm_name, reference_number, action_type, amount, date, summary, sourcebook_references)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const insertEnforcementsAll = db.transaction(() => {
  for (const e of enforcements) {
    insertEnforcement.run(
      e.firm_name,
      e.reference_number,
      e.action_type,
      e.amount,
      e.date,
      e.summary,
      e.sourcebook_references,
    );
  }
});

insertEnforcementsAll();

console.log(`Inserted ${enforcements.length} sample enforcement actions`);

// ── Summary ──────────────────────────────────────────────────────────────────

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

console.log(`\nDatenbank-Zusammenfassung:`);
console.log(`  Publikationskategorien:  ${sourcebookCount}`);
console.log(`  Bestimmungen:            ${provisionCount}`);
console.log(`  Durchsetzungsmassnahmen: ${enforcementCount}`);
console.log(`  FTS-Einträge:            ${ftsCount}`);
console.log(`\nAbgeschlossen. Datenbank bereit unter ${DB_PATH}`);

db.close();
