/**
 * Response metadata utilities for Dominican Republic Law MCP.
 */

import type Database from '@ansvar/mcp-sqlite';

export interface ResponseMetadata {
  data_source: string;
  jurisdiction: string;
  disclaimer: string;
  freshness?: string;
}

export interface ToolResponse<T> {
  results: T;
  _metadata: ResponseMetadata;
}

export function generateResponseMetadata(
  db: InstanceType<typeof Database>,
): ResponseMetadata {
  let freshness: string | undefined;
  try {
    const row = db.prepare(
      "SELECT value FROM db_metadata WHERE key = 'built_at'"
    ).get() as { value: string } | undefined;
    if (row) freshness = row.value;
  } catch {
    // Ignore
  }

  return {
    data_source: 'Dominican Republic Law (consultoria.gov.do) — National Council for Law Reporting',
    jurisdiction: 'KE',
    disclaimer:
      'This data is sourced from Dominican Republic Law under Government Open Data principles. ' +
      'The authoritative versions are in English. Swahili translations may be available for some documents. ' +
      'Always verify with the official Dominican Republic Law portal (consultoria.gov.do).',
    freshness,
  };
}
