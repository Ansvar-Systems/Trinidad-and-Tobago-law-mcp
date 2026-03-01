/**
 * Trinidad and Tobago Law PDF Parser
 *
 * Parses law text extracted from PDFs downloaded from
 * laws.gov.tt. Uses `pdftotext` (via execFileSync) for extraction,
 * then applies regex-based section parsing.
 *
 * Trinidad and Tobago follows English common law:
 *   "Section 1." / "1." / "1.-(1)"
 *   "PART I", "PART II"
 *   Short titles, interpretation sections, schedules
 *
 * Note: Uses execFileSync (not exec) to prevent command injection.
 */

import { execFileSync } from 'child_process';

export interface ActIndexEntry {
  id: string;
  title: string;
  titleEn: string;
  shortName: string;
  status: 'in_force' | 'amended' | 'repealed' | 'not_yet_in_force';
  issuedDate: string;
  inForceDate: string;
  url: string;
  description?: string;
}

export interface ParsedProvision {
  provision_ref: string;
  chapter?: string;
  section: string;
  title: string;
  content: string;
}

export interface ParsedDefinition {
  term: string;
  definition: string;
  source_provision?: string;
}

export interface ParsedAct {
  id: string;
  type: 'statute';
  title: string;
  title_en: string;
  short_name: string;
  status: string;
  issued_date: string;
  in_force_date: string;
  url: string;
  description?: string;
  provisions: ParsedProvision[];
  definitions: ParsedDefinition[];
}

/* ---------- PDF Text Extraction ---------- */

export function extractTextFromPdf(pdfPath: string): string {
  // Uses execFileSync (safe: no shell expansion, pdfPath is not interpolated into a shell command)
  try {
    return execFileSync('pdftotext', ['-layout', pdfPath, '-'], {
      maxBuffer: 50 * 1024 * 1024,
      encoding: 'utf-8',
      timeout: 30000,
    });
  } catch {
    try {
      return execFileSync('pdftotext', [pdfPath, '-'], {
        maxBuffer: 50 * 1024 * 1024,
        encoding: 'utf-8',
        timeout: 30000,
      });
    } catch {
      return '';
    }
  }
}

/* ---------- Text Parsing ---------- */

// Trinidad and Tobago section patterns (English common law)
const SECTION_PATTERNS = [
  // "3. (1) The Minister may..." or "3.-(1)"
  /(?:^|\n)\s*(\d+[A-Z]?)\s*[.\-]+\s*(?:\(1\)\s*)?([^\n]*)/gm,
  // "Section 3." explicit
  /(?:^|\n)\s*(?:Section|Sec\.?)\s+(\d+[A-Z]?)\s*[.\-:]+\s*([^\n]*)/gim,
];

// Part/Schedule patterns
const PART_RE = /(?:^|\n)\s*((?:PART|SCHEDULE|FIRST SCHEDULE|SECOND SCHEDULE|THIRD SCHEDULE)\s+[IVXLC0-9]+[^\n]*)/gim;

// Definition patterns for common law statutes
const DEFINITION_PATTERNS = [
  /["\u201C]([^"\u201D]{2,60})["\u201D]\s+means\s+([^;]+;)/gi,
  /["\u201C]([^"\u201D]{2,60})["\u201D]\s+includes\s+([^;]+;)/gi,
];

function cleanText(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\f/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function findLawTextStart(text: string): number {
  const startPatterns = [
    /\bENACTED\s+by\s+the\s+Parliament\b/i,
    /\bBE\s+IT\s+ENACTED\b/i,
    /\bShort\s+title\b/i,
    /(?:^|\n)\s*1\s*[.\-]+\s*(?:\(1\)|This\s+Act)/m,
    /\bPART\s+[I1]\b/i,
  ];

  let earliestPos = text.length;
  for (const pattern of startPatterns) {
    const match = pattern.exec(text);
    if (match && match.index < earliestPos) {
      earliestPos = match.index;
    }
  }

  return earliestPos === text.length ? 0 : earliestPos;
}

export function parseTTLawText(text: string, act: ActIndexEntry): ParsedAct {
  const cleaned = cleanText(text);
  const startIdx = findLawTextStart(cleaned);
  const lawText = cleaned.substring(startIdx);

  const provisions: ParsedProvision[] = [];
  const definitions: ParsedDefinition[] = [];

  interface Heading {
    ref: string;
    title: string;
    position: number;
  }

  const headings: Heading[] = [];

  for (const pattern of SECTION_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;

    while ((match = re.exec(lawText)) !== null) {
      const num = match[1].trim();
      const title = (match[2] ?? '').trim();
      const ref = `s${num}`;

      if (!headings.some(h => h.ref === ref && Math.abs(h.position - match!.index) < 20)) {
        headings.push({
          ref,
          title: title || `Section ${num}`,
          position: match.index,
        });
      }
    }
  }

  headings.sort((a, b) => a.position - b.position);

  const partRe = new RegExp(PART_RE.source, PART_RE.flags);
  const partPositions: { part: string; position: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = partRe.exec(lawText)) !== null) {
    partPositions.push({ part: match[1].trim(), position: match.index });
  }

  let currentPart = '';
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const nextHeading = headings[i + 1];
    const endPos = nextHeading ? nextHeading.position : lawText.length;
    const content = lawText.substring(heading.position, endPos).trim();

    for (const pp of partPositions) {
      if (pp.position <= heading.position) currentPart = pp.part;
    }

    const cleanedContent = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n');

    if (cleanedContent.length > 10) {
      provisions.push({
        provision_ref: heading.ref,
        chapter: currentPart || undefined,
        section: currentPart || act.title,
        title: heading.title,
        content: cleanedContent,
      });
    }
  }

  for (const pattern of DEFINITION_PATTERNS) {
    const defRe = new RegExp(pattern.source, pattern.flags);
    while ((match = defRe.exec(lawText)) !== null) {
      const term = (match[1] ?? '').trim();
      const definition = (match[2] ?? '').trim();
      if (term.length > 1 && term.length < 80 && definition.length > 10) {
        let sourceProvision: string | undefined;
        for (let i = headings.length - 1; i >= 0; i--) {
          if (headings[i].position <= match.index) {
            sourceProvision = headings[i].ref;
            break;
          }
        }
        definitions.push({ term, definition, source_provision: sourceProvision });
      }
    }
  }

  if (provisions.length === 0 && lawText.length > 50) {
    provisions.push({
      provision_ref: 'full-text',
      section: act.title,
      title: act.title,
      content: lawText.substring(0, 50000),
    });
  }

  return {
    id: act.id,
    type: 'statute',
    title: act.title,
    title_en: act.titleEn,
    short_name: act.shortName,
    status: act.status,
    issued_date: act.issuedDate,
    in_force_date: act.inForceDate,
    url: act.url,
    provisions,
    definitions,
  };
}

export function parseTTLawPdf(pdfPath: string, act: ActIndexEntry): ParsedAct {
  const text = extractTextFromPdf(pdfPath);
  if (!text || text.trim().length < 50) {
    return {
      id: act.id,
      type: 'statute',
      title: act.title,
      title_en: act.titleEn,
      short_name: act.shortName,
      status: act.status,
      issued_date: act.issuedDate,
      in_force_date: act.inForceDate,
      url: act.url,
      provisions: [],
      definitions: [],
    };
  }
  return parseTTLawText(text, act);
}

export function parseHtml(html: string, act: ActIndexEntry): ParsedAct {
  return parseTTLawText(html, act);
}
