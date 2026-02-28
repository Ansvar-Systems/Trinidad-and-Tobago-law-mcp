#!/usr/bin/env tsx
/**
 * Dominican Republic Law MCP -- Census Script
 *
 * Scrapes consultoria.gov.do to enumerate ALL laws.
 * Uses the ASP.NET MVC search form with CSRF token protection.
 *
 * Pipeline:
 *   1. GET the main page to obtain session cookie + CSRF token
 *   2. POST search with DocumentTypeCode=1 (Leyes) to get all laws
 *   3. Parse HTML table response for law entries
 *   4. Write data/census.json
 *
 * Source: https://www.consultoria.gov.do/consulta/
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

const BASE_URL = 'https://www.consultoria.gov.do';
const MAIN_URL = `${BASE_URL}/consulta/`;
const SEARCH_URL = `${BASE_URL}/Consulta/Home/Search?Length=7`;

const USER_AGENT = 'dominican-law-mcp/1.0 (census; https://github.com/Ansvar-Systems/dominican-law-mcp)';

/* ---------- Types ---------- */

interface RawLawEntry {
  tipo: string;
  numero: string;
  titulo: string;
  gaceta: string;
  fecha: string;
  documentId: string;
  downloadUrl: string;
}

/* ---------- HTTP Helpers ---------- */

/**
 * Fetch the main page to get session cookies and CSRF token.
 */
async function getSessionAndToken(): Promise<{ cookies: string; token: string }> {
  const response = await fetch(MAIN_URL, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html',
    },
    redirect: 'follow',
  });

  if (response.status !== 200) {
    throw new Error(`Failed to load main page: HTTP ${response.status}`);
  }

  // Extract cookies from response
  const setCookies = response.headers.getSetCookie?.() ?? [];
  const cookieHeader = setCookies
    .map(c => c.split(';')[0])
    .join('; ');

  const html = await response.text();

  // Extract CSRF token
  const tokenMatch = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]*)"/);
  if (!tokenMatch) {
    throw new Error('Failed to extract CSRF token from main page');
  }

  return { cookies: cookieHeader, token: tokenMatch[1] };
}

/**
 * Search for all laws using the ASP.NET MVC form.
 */
async function searchLaws(cookies: string, token: string): Promise<string> {
  const body = new URLSearchParams({
    __RequestVerificationToken: token,
    DocumentTypeCode: '1', // Leyes
    DocumentCategory: '0',
  });

  const response = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': '*/*',
      'Origin': BASE_URL,
      'Referer': MAIN_URL,
      'Cookie': cookies,
    },
    body: body.toString(),
    redirect: 'follow',
  });

  if (response.status !== 200) {
    throw new Error(`Search request failed: HTTP ${response.status}`);
  }

  return response.text();
}

/* ---------- Parsing ---------- */

function parseSearchResults(html: string): RawLawEntry[] {
  const entries: RawLawEntry[] = [];

  // Match table rows with 6 cells
  const rowRe = /<tr>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;
  let match: RegExpExecArray | null;

  while ((match = rowRe.exec(html)) !== null) {
    const tipo = stripTags(match[1]).trim();
    const numero = stripTags(match[2]).trim();
    const titulo = decodeEntities(stripTags(match[3]).trim());
    const gaceta = stripTags(match[4]).trim();
    const fecha = stripTags(match[5]).trim();
    const opciones = match[6];

    // Extract documentId from link
    const docIdMatch = opciones.match(/documentId=(\d+)/);
    const documentId = docIdMatch ? docIdMatch[1] : '';

    if (documentId && titulo) {
      entries.push({
        tipo,
        numero,
        titulo,
        gaceta,
        fecha,
        documentId,
        downloadUrl: `${BASE_URL}/Consulta/Home/FileManagement?documentId=${documentId}&managementType=1`,
      });
    }
  }

  return entries;
}

function stripTags(text: string): string {
  return text.replace(/<[^>]*>/g, '');
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#209;/g, 'Ñ').replace(/&#241;/g, 'ñ')
    .replace(/&#193;/g, 'Á').replace(/&#225;/g, 'á')
    .replace(/&#201;/g, 'É').replace(/&#233;/g, 'é')
    .replace(/&#205;/g, 'Í').replace(/&#237;/g, 'í')
    .replace(/&#211;/g, 'Ó').replace(/&#243;/g, 'ó')
    .replace(/&#218;/g, 'Ú').replace(/&#250;/g, 'ú')
    .replace(/&#252;/g, 'ü').replace(/&#220;/g, 'Ü')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50);
}

function parseDRDate(dateStr: string): string {
  // Format: "30/09/1920"
  const match = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (match) {
    const [, day, month, year] = match;
    return `${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}`;
  }
  return '';
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

  console.log('Dominican Republic Law MCP -- Census');
  console.log('=====================================\n');
  console.log('  Source: consultoria.gov.do/consulta/');
  console.log('  Method: ASP.NET MVC search form (POST with CSRF token)');
  if (limit) console.log(`  --limit ${limit}`);
  console.log('');

  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Step 1: Get session + CSRF token
  process.stdout.write('  Getting session and CSRF token... ');
  const { cookies, token } = await getSessionAndToken();
  console.log('OK');

  // Step 2: Search for all laws
  process.stdout.write('  Searching for all laws (DocumentTypeCode=1)... ');
  const searchHtml = await searchLaws(cookies, token);
  console.log(`OK (${(searchHtml.length / 1024).toFixed(0)} KB response)`);

  // Step 3: Parse results
  process.stdout.write('  Parsing search results... ');
  const rawEntries = parseSearchResults(searchHtml);
  console.log(`${rawEntries.length} laws found`);

  // Build census entries
  const laws = rawEntries
    .slice(0, limit ?? rawEntries.length)
    .map((entry, idx) => {
      const date = parseDRDate(entry.fecha);
      const id = `do-ley-${entry.numero || idx}-${slugify(entry.titulo).substring(0, 30)}`;

      return {
        id,
        title: entry.titulo,
        identifier: entry.numero ? `Ley No. ${entry.numero}` : entry.titulo,
        url: entry.downloadUrl,
        status: 'in_force' as const,
        category: 'act' as const,
        classification: entry.downloadUrl ? 'ingestable' as const : 'inaccessible' as const,
        ingested: false,
        provision_count: 0,
        ingestion_date: null as string | null,
        issued_date: date,
        gaceta: entry.gaceta,
        document_id: entry.documentId,
      };
    });

  const ingestable = laws.filter(l => l.classification === 'ingestable').length;
  const inaccessible = laws.filter(l => l.classification === 'inaccessible').length;

  const census = {
    schema_version: '2.0',
    jurisdiction: 'DO',
    jurisdiction_name: 'Dominican Republic',
    portal: 'consultoria.gov.do',
    census_date: new Date().toISOString().split('T')[0],
    agent: 'dominican-law-mcp/census.ts',
    summary: {
      total_laws: laws.length,
      ingestable,
      ocr_needed: 0,
      inaccessible,
      excluded: 0,
    },
    laws,
  };

  fs.writeFileSync(CENSUS_PATH, JSON.stringify(census, null, 2));

  console.log('\n==================================================');
  console.log('CENSUS COMPLETE');
  console.log('==================================================');
  console.log(`  Total laws discovered:  ${laws.length}`);
  console.log(`  Ingestable:             ${ingestable}`);
  console.log(`  Inaccessible:           ${inaccessible}`);
  console.log(`\n  Output: ${CENSUS_PATH}`);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
