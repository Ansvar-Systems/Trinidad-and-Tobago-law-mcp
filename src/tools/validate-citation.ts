/**
 * validate_citation — Validate a Dominican legal citation against the database.
 */

import type Database from '@ansvar/mcp-sqlite';
import { resolveDocumentId } from '../utils/statute-id.js';
import { generateResponseMetadata, type ToolResponse } from '../utils/metadata.js';

export interface ValidateCitationInput {
  citation: string;
}

export interface ValidateCitationResult {
  valid: boolean;
  citation: string;
  normalized?: string;
  document_id?: string;
  document_title?: string;
  provision_ref?: string;
  status?: string;
  warnings: string[];
}

/**
 * Parse a Dominican legal citation.
 * Supports:
 * - "Section 25, Data Protection Act 2019"
 * - "s 25, Data Protection Act 2019"
 * - "Section 25 of the Data Protection Act, 2019"
 * - "Data Protection Act 2019, Section 25"
 * - "Article 31, Constitution of Dominican Republic 2010"
 * - Just an Act title
 */
function parseCitation(citation: string): { documentRef: string; sectionRef?: string } | null {
  const trimmed = citation.trim();

  // "Section N, <Act>" or "s N, <Act>" or "Section N of the <Act>"
  const secFirst = trimmed.match(
    /^(?:Section|s|sec\.?)\s*(\d+[A-Za-z]*)\s*(?:,|of(?:\s+the)?)\s+(.+)$/i
  );
  if (secFirst) {
    return { documentRef: secFirst[2].trim().replace(/^the\s+/i, ''), sectionRef: secFirst[1] };
  }

  // "Article N, <Act>" (Constitution)
  const artFirst = trimmed.match(
    /^(?:Article|Art\.?)\s*(\d+[A-Za-z]*)\s*(?:,|of(?:\s+the)?)\s+(.+)$/i
  );
  if (artFirst) {
    return { documentRef: artFirst[2].trim().replace(/^the\s+/i, ''), sectionRef: artFirst[1] };
  }

  // "<Act>, Section N" or "<Act> Section N"
  const secLast = trimmed.match(
    /^(.+?)[,;]?\s*(?:Section|s|sec\.?)\s*(\d+[A-Za-z]*)$/i
  );
  if (secLast) {
    return { documentRef: secLast[1].trim(), sectionRef: secLast[2] };
  }

  // "<Act>, Article N"
  const artLast = trimmed.match(
    /^(.+?)[,;]?\s*(?:Article|Art\.?)\s*(\d+[A-Za-z]*)$/i
  );
  if (artLast) {
    return { documentRef: artLast[1].trim(), sectionRef: artLast[2] };
  }

  // Just a document reference
  return { documentRef: trimmed };
}

export async function validateCitationTool(
  db: InstanceType<typeof Database>,
  input: ValidateCitationInput,
): Promise<ToolResponse<ValidateCitationResult>> {
  const warnings: string[] = [];
  const parsed = parseCitation(input.citation);

  if (!parsed) {
    return {
      results: {
        valid: false,
        citation: input.citation,
        warnings: ['Could not parse citation format'],
      },
      _metadata: generateResponseMetadata(db),
    };
  }

  const docId = resolveDocumentId(db, parsed.documentRef);
  if (!docId) {
    return {
      results: {
        valid: false,
        citation: input.citation,
        warnings: [`Document not found: "${parsed.documentRef}"`],
      },
      _metadata: generateResponseMetadata(db),
    };
  }

  const doc = db.prepare(
    'SELECT id, title, status FROM legal_documents WHERE id = ?'
  ).get(docId) as { id: string; title: string; status: string };

  if (doc.status === 'repealed') {
    warnings.push(`WARNING: This statute has been repealed.`);
  } else if (doc.status === 'amended') {
    warnings.push(`Note: This statute has been amended. Verify you are referencing the current version.`);
  } else if (doc.status === 'partially_suspended') {
    warnings.push(`Note: Certain sections of this statute have been suspended. Verify which sections are in force.`);
  }

  if (parsed.sectionRef) {
    const provision = db.prepare(
      "SELECT provision_ref FROM legal_provisions WHERE document_id = ? AND (provision_ref = ? OR provision_ref = ? OR provision_ref = ? OR section = ?)"
    ).get(docId, parsed.sectionRef, `s${parsed.sectionRef}`, `art${parsed.sectionRef}`, parsed.sectionRef) as { provision_ref: string } | undefined;

    if (!provision) {
      return {
        results: {
          valid: false,
          citation: input.citation,
          document_id: docId,
          document_title: doc.title,
          warnings: [...warnings, `Provision "${parsed.sectionRef}" not found in ${doc.title}`],
        },
        _metadata: generateResponseMetadata(db),
      };
    }

    return {
      results: {
        valid: true,
        citation: input.citation,
        normalized: `Section ${parsed.sectionRef}, ${doc.title}`,
        document_id: docId,
        document_title: doc.title,
        provision_ref: provision.provision_ref,
        status: doc.status,
        warnings,
      },
      _metadata: generateResponseMetadata(db),
    };
  }

  return {
    results: {
      valid: true,
      citation: input.citation,
      normalized: doc.title,
      document_id: docId,
      document_title: doc.title,
      status: doc.status,
      warnings,
    },
    _metadata: generateResponseMetadata(db),
  };
}
