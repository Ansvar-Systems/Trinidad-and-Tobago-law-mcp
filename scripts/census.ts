#!/usr/bin/env tsx
/**
 * Trinidad and Tobago Law MCP -- Census Script
 *
 * Scrapes laws.gov.tt to enumerate ALL acts and ordinances.
 * Uses the alphabetical bytitle index (A-Z) with pagination.
 *
 * Portal structure:
 *   /ttdll-web2/revision/bytitle?q={letter}&offset={n}
 *   Each page has up to 30 entries with download links:
 *   /ttdll-web2/revision/download/{ID}?type=amendment
 *
 * Source: https://laws.gov.tt
 *
 * Usage:
 *   npx tsx scripts/census.ts
 *   npx tsx scripts/census.ts --limit 100
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.resolve(__dirname, '../data');
const CENSUS_PATH = path.join(DATA_DIR, 'census.json');

const BASE_URL = 'https://laws.gov.tt';
const BYTITLE_URL = `${BASE_URL}/ttdll-web2/revision/bytitle`;
const PAGE_SIZE = 30;
const MIN_DELAY_MS = 300;

const USER_AGENT = 'trinidadian-law-mcp/1.0 (census; https://github.com/Ansvar-Systems/Trinidad-and-Tobago-law-mcp)';

/* ---------- Types ---------- */

interface RawActEntry {
  downloadId: string;
  reference: string;
  title: string;
  downloadUrl: string;
}

/* ---------- HTTP ---------- */

async function fetchPage(letter: string, offset: number): Promise<string> {
  await new Promise(resolve => setTimeout(resolve, MIN_DELAY_MS));

  const url = `${BYTITLE_URL}?q=${letter}&offset=${offset}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html',
    },
    redirect: 'follow',
  });

  if (response.status !== 200) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response.text();
}

/* ---------- Parsing ---------- */

function parsePageEntries(html: string): RawActEntry[] {
  const entries: RawActEntry[] = [];

  // Match download IDs from href attributes
  const downloadRe = /download\/(\d+)\?type=amendment/g;
  const titleRe = /<td>([^<]{3,})<\/td>/g;

  const downloads: { id: string; pos: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = downloadRe.exec(html)) !== null) {
    downloads.push({ id: match[1], pos: match.index });
  }

  const titles: { text: string; pos: number }[] = [];
  while ((match = titleRe.exec(html)) !== null) {
    const text = match[1].trim();
    if (text.length > 2 && !text.includes('<') && !text.startsWith('pdf')) {
      titles.push({ text, pos: match.index });
    }
  }

  const refRe = /<strong[^>]*>([^<]+)<\/strong>/g;
  const refs: { text: string; pos: number }[] = [];
  while ((match = refRe.exec(html)) !== null) {
    refs.push({ text: match[1].trim(), pos: match.index });
  }

  const seenIds = new Set<string>();
  for (const dl of downloads) {
    if (seenIds.has(dl.id)) continue;
    seenIds.add(dl.id);

    const nearestTitle = titles.find(t => t.pos > dl.pos);
    const nearestRef = refs.find(r => Math.abs(r.pos - dl.pos) < 500);

    if (nearestTitle) {
      entries.push({
        downloadId: dl.id,
        reference: nearestRef?.text || '',
        title: nearestTitle.text,
        downloadUrl: `${BASE_URL}/ttdll-web2/revision/download/${dl.id}?type=amendment`,
      });
    }
  }

  return entries;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60);
}

function parseArgs(): { limit: number | null } {
  const args = process.argv.slice(2);
  let limit: number | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    }
  }
  return { limit };
}

/* ---------- Main ---------- */

async function main(): Promise<void> {
  const { limit } = parseArgs();

  console.log('Trinidad and Tobago Law MCP -- Census');
  console.log('======================================\n');
  console.log('  Source: laws.gov.tt (Digital Law Library)');
  console.log('  Method: Alphabetical index (A-Z) with pagination');
  if (limit) console.log(`  --limit ${limit}`);
  console.log('');

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const allEntries: RawActEntry[] = [];
  const seenIds = new Set<string>();
  const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');

  for (const letter of letters) {
    let offset = 0;
    let letterCount = 0;

    while (true) {
      process.stdout.write(`  [${letter.toUpperCase()}] offset=${offset}...`);
      const html = await fetchPage(letter, offset);
      const entries = parsePageEntries(html);

      if (entries.length === 0) {
        console.log(' 0 (done)');
        break;
      }

      let newCount = 0;
      for (const entry of entries) {
        if (!seenIds.has(entry.downloadId)) {
          seenIds.add(entry.downloadId);
          allEntries.push(entry);
          newCount++;
        }
      }

      letterCount += newCount;
      console.log(` ${entries.length} found, ${newCount} new`);

      if (entries.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;

      if (limit && allEntries.length >= limit) break;
    }

    console.log(`  [${letter.toUpperCase()}] subtotal: ${letterCount}`);
    if (limit && allEntries.length >= limit) break;
  }

  const laws = allEntries
    .slice(0, limit ?? allEntries.length)
    .map((entry) => {
      const id = `tt-${slugify(entry.title)}-${entry.downloadId}`;
      const yearMatch = entry.reference.match(/of\s+(\d{4})/i);
      const year = yearMatch ? yearMatch[1] : '';

      return {
        id,
        title: entry.title,
        identifier: entry.reference || entry.title,
        url: entry.downloadUrl,
        status: 'in_force' as const,
        category: 'act' as const,
        classification: 'ingestable' as const,
        ingested: false,
        provision_count: 0,
        ingestion_date: null as string | null,
        issued_date: year ? `${year}-01-01` : '',
        download_id: entry.downloadId,
      };
    });

  const census = {
    schema_version: '2.0',
    jurisdiction: 'TT',
    jurisdiction_name: 'Trinidad and Tobago',
    portal: 'laws.gov.tt',
    census_date: new Date().toISOString().split('T')[0],
    agent: 'trinidadian-law-mcp/census.ts',
    summary: {
      total_laws: laws.length,
      ingestable: laws.filter(l => l.classification === 'ingestable').length,
      ocr_needed: 0,
      inaccessible: 0,
      excluded: 0,
    },
    laws,
  };

  fs.writeFileSync(CENSUS_PATH, JSON.stringify(census, null, 2));

  console.log('\n==================================================');
  console.log('CENSUS COMPLETE');
  console.log('==================================================');
  console.log(`  Total acts discovered:  ${laws.length}`);
  console.log(`  Ingestable:             ${census.summary.ingestable}`);
  console.log(`\n  Output: ${CENSUS_PATH}`);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
