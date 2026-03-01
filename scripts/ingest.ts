#!/usr/bin/env tsx
/**
 * Trinidad and Tobago Law MCP -- Census-Driven Ingestion Pipeline
 *
 * Reads data/census.json and fetches + parses every ingestable Act
 * from laws.gov.tt (PDF downloads).
 *
 * Pipeline per law:
 *   1. Download PDF from laws.gov.tt/ttdll-web2/revision/download/{ID}
 *   2. Extract text using pdftotext (poppler-utils)
 *   3. Parse sections, definitions, part structure
 *   4. Write seed JSON for build-db.ts
 *
 * Features:
 *   - Resume support: skips Acts that already have a seed JSON file
 *   - Census update: writes provision counts + ingestion dates back to census.json
 *   - Rate limiting: 300ms minimum between requests
 *
 * Usage:
 *   npm run ingest                    # Full census-driven ingestion
 *   npm run ingest -- --limit 5       # Test with 5 acts
 *   npm run ingest -- --skip-fetch    # Reuse cached PDFs (re-parse only)
 *   npm run ingest -- --force         # Re-ingest even if seed exists
 *
 * Data source: laws.gov.tt (Digital Law Library)
 * Format: PDF (text extracted via pdftotext)
 * License: Government Publication (public domain)
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseTTLawPdf, type ActIndexEntry, type ParsedAct } from './lib/parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SOURCE_DIR = path.resolve(__dirname, '../data/source');
const SEED_DIR = path.resolve(__dirname, '../data/seed');
const CENSUS_PATH = path.resolve(__dirname, '../data/census.json');

const USER_AGENT = 'trinidadian-law-mcp/1.0 (https://github.com/Ansvar-Systems/Trinidad-and-Tobago-law-mcp; hello@ansvar.ai)';
const MIN_DELAY_MS = 300;

/* ---------- Types ---------- */

interface CensusLawEntry {
  id: string;
  title: string;
  identifier: string;
  url: string;
  status: 'in_force' | 'amended' | 'repealed';
  category: 'act';
  classification: 'ingestable' | 'excluded' | 'inaccessible';
  ingested: boolean;
  provision_count: number;
  ingestion_date: string | null;
  issued_date?: string;
  download_id?: string;
}

interface CensusFile {
  schema_version: string;
  jurisdiction: string;
  jurisdiction_name: string;
  portal: string;
  census_date: string;
  agent: string;
  summary: {
    total_laws: number;
    ingestable: number;
    ocr_needed: number;
    inaccessible: number;
    excluded: number;
  };
  laws: CensusLawEntry[];
}

/* ---------- Helpers ---------- */

function parseArgs(): { limit: number | null; skipFetch: boolean; force: boolean } {
  const args = process.argv.slice(2);
  let limit: number | null = null;
  let skipFetch = false;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--skip-fetch') {
      skipFetch = true;
    } else if (args[i] === '--force') {
      force = true;
    }
  }

  return { limit, skipFetch, force };
}

function censusToActEntry(law: CensusLawEntry): ActIndexEntry {
  return {
    id: law.id,
    title: law.title,
    titleEn: law.title,
    shortName: law.identifier || law.title,
    status: law.status === 'in_force' ? 'in_force' : law.status === 'amended' ? 'amended' : 'repealed',
    issuedDate: law.issued_date ?? '',
    inForceDate: law.issued_date ?? '',
    url: law.url,
  };
}

async function downloadPdf(url: string, outputPath: string): Promise<boolean> {
  await new Promise(resolve => setTimeout(resolve, MIN_DELAY_MS));

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/pdf, */*',
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.status !== 200) {
      console.log(` HTTP ${response.status}`);
      return false;
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.length < 100 || !buffer.subarray(0, 5).toString().startsWith('%PDF')) {
      console.log(' Not a PDF');
      return false;
    }

    fs.writeFileSync(outputPath, buffer);
    return true;
  } catch (err) {
    console.log(` Error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/* ---------- Main ---------- */

async function main(): Promise<void> {
  const { limit, skipFetch, force } = parseArgs();

  console.log('Trinidad and Tobago Law MCP -- Ingestion Pipeline (Census-Driven)');
  console.log('==================================================================\n');
  console.log('  Source: laws.gov.tt (Digital Law Library)');
  console.log('  Format: PDF (text extracted via pdftotext)');

  if (limit) console.log(`  --limit ${limit}`);
  if (skipFetch) console.log(`  --skip-fetch`);
  if (force) console.log(`  --force`);

  if (!fs.existsSync(CENSUS_PATH)) {
    console.error(`\nERROR: Census file not found at ${CENSUS_PATH}`);
    console.error('Run "npx tsx scripts/census.ts" first.');
    process.exit(1);
  }

  const census: CensusFile = JSON.parse(fs.readFileSync(CENSUS_PATH, 'utf-8'));
  const ingestable = census.laws.filter(l => l.classification === 'ingestable');
  const acts = limit ? ingestable.slice(0, limit) : ingestable;

  console.log(`\n  Census: ${census.summary.total_laws} total, ${ingestable.length} ingestable`);
  console.log(`  Processing: ${acts.length} acts\n`);

  fs.mkdirSync(SOURCE_DIR, { recursive: true });
  fs.mkdirSync(SEED_DIR, { recursive: true });

  let processed = 0;
  let ingested = 0;
  let skipped = 0;
  let failed = 0;
  let totalProvisions = 0;
  let totalDefinitions = 0;

  const censusMap = new Map<string, CensusLawEntry>();
  for (const law of census.laws) {
    censusMap.set(law.id, law);
  }

  const today = new Date().toISOString().split('T')[0];

  for (const law of acts) {
    const act = censusToActEntry(law);
    const sourceFile = path.join(SOURCE_DIR, `${act.id}.pdf`);
    const seedFile = path.join(SEED_DIR, `${act.id}.json`);

    // Resume support
    if (!force && fs.existsSync(seedFile)) {
      try {
        const existing = JSON.parse(fs.readFileSync(seedFile, 'utf-8')) as ParsedAct;
        const provCount = existing.provisions?.length ?? 0;
        const defCount = existing.definitions?.length ?? 0;
        totalProvisions += provCount;
        totalDefinitions += defCount;

        const entry = censusMap.get(law.id);
        if (entry) {
          entry.ingested = true;
          entry.provision_count = provCount;
          entry.ingestion_date = entry.ingestion_date ?? today;
        }

        skipped++;
        processed++;
        continue;
      } catch {
        // Corrupt seed file, re-ingest
      }
    }

    try {
      // Download PDF
      if (!fs.existsSync(sourceFile) || force) {
        if (skipFetch) {
          console.log(`  [${processed + 1}/${acts.length}] No cached PDF for ${act.id}, skipping`);
          failed++;
          processed++;
          continue;
        }

        process.stdout.write(`  [${processed + 1}/${acts.length}] Downloading ${act.id}...`);
        const ok = await downloadPdf(act.url, sourceFile);
        if (!ok) {
          const entry = censusMap.get(law.id);
          if (entry) entry.classification = 'inaccessible';
          failed++;
          processed++;
          continue;
        }

        const size = fs.statSync(sourceFile).size;
        console.log(` OK (${(size / 1024).toFixed(0)} KB)`);
      } else {
        const size = fs.statSync(sourceFile).size;
        console.log(`  [${processed + 1}/${acts.length}] Using cached ${act.id} (${(size / 1024).toFixed(0)} KB)`);
      }

      // Parse PDF
      const parsed = parseTTLawPdf(sourceFile, act);
      fs.writeFileSync(seedFile, JSON.stringify(parsed, null, 2));
      totalProvisions += parsed.provisions.length;
      totalDefinitions += parsed.definitions.length;
      console.log(`    -> ${parsed.provisions.length} provisions, ${parsed.definitions.length} definitions`);

      const entry = censusMap.get(law.id);
      if (entry) {
        entry.ingested = true;
        entry.provision_count = parsed.provisions.length;
        entry.ingestion_date = today;
      }

      ingested++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`  ERROR parsing ${act.id}: ${msg}`);
      failed++;
    }

    processed++;

    if (processed % 50 === 0) {
      writeCensus(census, censusMap);
      console.log(`  [checkpoint] Census updated at ${processed}/${acts.length}`);
    }
  }

  writeCensus(census, censusMap);

  console.log(`\n${'='.repeat(70)}`);
  console.log('Ingestion Report');
  console.log('='.repeat(70));
  console.log(`\n  Source:      laws.gov.tt (PDF extraction)`);
  console.log(`  Processed:   ${processed}`);
  console.log(`  New:         ${ingested}`);
  console.log(`  Resumed:     ${skipped}`);
  console.log(`  Failed:      ${failed}`);
  console.log(`  Total provisions:  ${totalProvisions}`);
  console.log(`  Total definitions: ${totalDefinitions}`);
  console.log('');
}

function writeCensus(census: CensusFile, censusMap: Map<string, CensusLawEntry>): void {
  census.laws = Array.from(censusMap.values()).sort((a, b) =>
    a.title.localeCompare(b.title),
  );

  census.summary.total_laws = census.laws.length;
  census.summary.ingestable = census.laws.filter(l => l.classification === 'ingestable').length;
  census.summary.inaccessible = census.laws.filter(l => l.classification === 'inaccessible').length;
  census.summary.excluded = census.laws.filter(l => l.classification === 'excluded').length;

  fs.writeFileSync(CENSUS_PATH, JSON.stringify(census, null, 2));
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
