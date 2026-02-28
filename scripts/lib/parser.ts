/**
 * Dominican Republic Law PDF/Text Parser
 *
 * Parses law text extracted from PDFs downloaded from
 * consultoria.gov.do. Uses `pdftotext` for extraction,
 * then applies regex-based article parsing.
 *
 * Dominican Republic article patterns:
 *   "ARTICULO lo.-" (older laws, ordinal suffixes)
 *   "Artículo 1.-"
 *   "Art. 1.-"
 *   "ARTICULO UNICO.-"
 *   "PARRAFO.-" / "Párrafo.-"
 *
 * Structure patterns:
 *   "TITULO I", "CAPITULO I", "SECCION I"
 */

import { execSync } from 'child_process';

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
  try {
    const result = execSync(`pdftotext -layout "${pdfPath}" -`, {
      maxBuffer: 50 * 1024 * 1024,
      encoding: 'utf-8',
      timeout: 30000,
    });
    return result;
  } catch {
    try {
      const result = execSync(`pdftotext "${pdfPath}" -`, {
        maxBuffer: 50 * 1024 * 1024,
        encoding: 'utf-8',
        timeout: 30000,
      });
      return result;
    } catch {
      return '';
    }
  }
}

/* ---------- Text Parsing ---------- */

// Older DR laws use "ARTICULO lo." with ordinal suffix patterns
// Modern laws use "Artículo 1.-"
const ARTICLE_PATTERNS = [
  // Modern: "Artículo 1.-", "Art. 1.-"
  /(?:^|\n)\s*(?:Art[ií]culo|Art\.?)\s+((?:\d+[\s.]*(?:bis|ter)?|\d+[A-Z]?(?:\.\d+)?|[ÚU]NICO))\s*[.°º]*[-.:–]?\s*([^\n]*)/gimu,
  // Older: "ARTICULO lo.-", "ARTICULO 2o.-", "ARTICULO UNICO.-"
  /(?:^|\n)\s*ARTICULO\s+(\d+)\s*[oOº°]\s*[.]*[-.:–]?\s*([^\n]*)/gimu,
];

// Párrafo patterns (Dominican-specific sub-articles)
const PARRAFO_RE = /(?:^|\n)\s*(?:P[AÁ]RRAFO|PARAGRAFO)\s*((?:I{1,3}V?|V?I{0,3}|[ÚU]NICO|\d+)?)\s*[.°º]*[-.:–]?\s*([^\n]*)/gimu;

// Chapter/Title patterns
const CHAPTER_RE = /(?:^|\n)\s*((?:CAP[ÍI]TULO|T[ÍI]TULO|SECCI[ÓO]N)\s+[IVXLC0-9]+[^\n]*)/gimu;

// Definition patterns
const DEFINITION_PATTERNS = [
  /se\s+(?:define|entiende|entender[aá])\s+(?:como|por)\s+"?([^".:]+)"?\s*(?:como|a|:)\s*([^.]+\.)/gi,
  /(?:Para\s+(?:los\s+)?efectos?\s+de\s+(?:esta|la\s+presente)\s+(?:ley|norma)[^:]*:\s*)\n?\s*(?:\d+[.)]\s*)?([^:–-]+)\s*[:–-]\s*([^.;]+[.;])/gim,
];

function decodeEntities(text: string): string {
  return text
    .replace(/&aacute;/g, 'á').replace(/&eacute;/g, 'é')
    .replace(/&iacute;/g, 'í').replace(/&oacute;/g, 'ó')
    .replace(/&uacute;/g, 'ú').replace(/&ntilde;/g, 'ñ')
    .replace(/&Aacute;/g, 'Á').replace(/&Eacute;/g, 'É')
    .replace(/&Iacute;/g, 'Í').replace(/&Oacute;/g, 'Ó')
    .replace(/&Uacute;/g, 'Ú').replace(/&Ntilde;/g, 'Ñ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));
}

function cleanText(text: string): string {
  return decodeEntities(text)
    .replace(/<[^>]*>/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\f/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Find the start of the actual law text.
 * DR laws often start with preamble from the executive/congress.
 */
function findLawTextStart(text: string): number {
  const startPatterns = [
    /\b(?:EL\s+CONGRESO\s+NACIONAL)\b/i,
    /\bCONSIDERANDO\b/i,
    /\b(?:EN\s+NOMBRE\s+DE\s+LA\s+REP[ÚU]BLICA)\b/i,
    /\bHA\s+DADO\s+LA\s+SIGUIENTE\s+LEY\b/i,
    /\bDECRETA\s*:/i,
    /\bRESUELVE\s*:/i,
    /(?:^|\n)\s*(?:ARTICULO|Art[ií]culo)\s+(?:1|lo\.?|PRIMERO|[ÚU]NICO)\s*[.°º]*[-.:–]/im,
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

/**
 * Parse extracted PDF text into provisions.
 */
export function parseDominicanLawText(text: string, act: ActIndexEntry): ParsedAct {
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

  // Try all article patterns
  for (const pattern of ARTICLE_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;

    while ((match = re.exec(lawText)) !== null) {
      const num = match[1].replace(/\s+/g, '').replace(/\.$/, '');
      const title = (match[2] ?? '').trim();
      const ref = `art${num.toLowerCase()}`;

      // Avoid duplicate refs at same position
      if (!headings.some(h => h.ref === ref && Math.abs(h.position - match!.index) < 20)) {
        headings.push({
          ref,
          title: title || `Artículo ${num}`,
          position: match.index,
        });
      }
    }
  }

  // Párrafo headings (as sub-provisions)
  const parrafoRe = new RegExp(PARRAFO_RE.source, PARRAFO_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = parrafoRe.exec(lawText)) !== null) {
    const num = (match[1] ?? '').trim() || 'unico';
    const title = (match[2] ?? '').trim();

    // Find the parent article for this párrafo
    let parentRef = '';
    for (const h of headings) {
      if (h.position <= match.index) {
        parentRef = h.ref;
      }
    }

    const ref = parentRef ? `${parentRef}-parrafo-${num.toLowerCase()}` : `parrafo-${num.toLowerCase()}`;
    headings.push({
      ref,
      title: title || `Párrafo ${num}`,
      position: match.index,
    });
  }

  // Sort by position
  headings.sort((a, b) => a.position - b.position);

  // Track current chapter
  const chapterRe = new RegExp(CHAPTER_RE.source, CHAPTER_RE.flags);
  const chapterPositions: { chapter: string; position: number }[] = [];
  while ((match = chapterRe.exec(lawText)) !== null) {
    chapterPositions.push({
      chapter: match[1].trim(),
      position: match.index,
    });
  }

  // Extract content between headings
  let currentChapter = '';
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const nextHeading = headings[i + 1];
    const endPos = nextHeading ? nextHeading.position : lawText.length;
    const content = lawText.substring(heading.position, endPos).trim();

    // Determine chapter
    for (const cp of chapterPositions) {
      if (cp.position <= heading.position) {
        currentChapter = cp.chapter;
      }
    }

    const cleanedContent = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n');

    if (cleanedContent.length > 10) {
      provisions.push({
        provision_ref: heading.ref,
        chapter: currentChapter || undefined,
        section: currentChapter || act.title,
        title: heading.title,
        content: cleanedContent,
      });
    }
  }

  // Extract definitions
  for (const pattern of DEFINITION_PATTERNS) {
    const defRe = new RegExp(pattern.source, pattern.flags);
    while ((match = defRe.exec(lawText)) !== null) {
      const term = (match[1] ?? '').trim();
      const definition = (match[2] ?? '').trim();
      if (term.length > 2 && term.length < 100 && definition.length > 10) {
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

  // Fallback: single provision for entire text
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

/**
 * Parse a PDF file into a ParsedAct.
 */
export function parseDominicanLawPdf(pdfPath: string, act: ActIndexEntry): ParsedAct {
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
  return parseDominicanLawText(text, act);
}

// Aliases for ingest.ts compatibility
export function parseHtml(html: string, act: ActIndexEntry): ParsedAct {
  return parseDominicanLawText(html, act);
}

export { parseDominicanLawPdf as parseDominicanLawHtml };
