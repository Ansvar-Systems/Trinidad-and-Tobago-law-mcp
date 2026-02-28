/**
 * format_citation — Format a Dominican legal citation per standard conventions.
 */

import { generateResponseMetadata, type ToolResponse } from '../utils/metadata.js';
import type Database from '@ansvar/mcp-sqlite';

export interface FormatCitationInput {
  citation: string;
  format?: 'full' | 'short' | 'pinpoint';
}

export interface FormatCitationResult {
  original: string;
  formatted: string;
  format: string;
}

export async function formatCitationTool(
  input: FormatCitationInput,
): Promise<FormatCitationResult> {
  const format = input.format ?? 'full';
  const trimmed = input.citation.trim();

  // Parse "Section N, <Act>" or "s N <Act>"
  const secFirst = trimmed.match(/^(?:Section|s|sec\.?)\s*(\d+[A-Za-z]*)\s*[,;]?\s+(.+)$/i);
  // Parse "<Act>, Section N" or "<Act> Section N"
  const secLast = trimmed.match(/^(.+?)[,;]?\s*(?:Section|s|sec\.?)\s*(\d+[A-Za-z]*)$/i);
  // Parse "Article N, <Act>"
  const artFirst = trimmed.match(/^(?:Article|Art\.?)\s*(\d+[A-Za-z]*)\s*[,;]?\s+(.+)$/i);
  const artLast = trimmed.match(/^(.+?)[,;]?\s*(?:Article|Art\.?)\s*(\d+[A-Za-z]*)$/i);

  const section = secFirst?.[1] ?? secLast?.[2] ?? artFirst?.[1] ?? artLast?.[2];
  const law = secFirst?.[2] ?? secLast?.[1] ?? artFirst?.[2] ?? artLast?.[1] ?? trimmed;
  const isArticle = !!(artFirst || artLast);

  const prefix = isArticle ? 'Article' : 'Section';

  let formatted: string;
  switch (format) {
    case 'short':
      formatted = section ? `s ${section}, ${law.split('(')[0].trim()}` : law;
      break;
    case 'pinpoint':
      formatted = section ? `s ${section}` : law;
      break;
    case 'full':
    default:
      formatted = section ? `${prefix} ${section}, ${law}` : law;
      break;
  }

  return { original: input.citation, formatted, format };
}
