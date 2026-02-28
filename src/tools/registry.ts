/**
 * Tool registry for Trinidad and Tobago Law MCP Server.
 * 8 core tools (non-EU jurisdiction — no EU tools).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type Database from '@ansvar/mcp-sqlite';

import { searchLegislation, type SearchLegislationInput } from './search-legislation.js';
import { getProvision, type GetProvisionInput } from './get-provision.js';
import { validateCitationTool, type ValidateCitationInput } from './validate-citation.js';
import { buildLegalStance, type BuildLegalStanceInput } from './build-legal-stance.js';
import { formatCitationTool, type FormatCitationInput } from './format-citation.js';
import { checkCurrency, type CheckCurrencyInput } from './check-currency.js';
import { listSources } from './list-sources.js';
import { getAbout, type AboutContext } from './about.js';
import { detectCapabilities, upgradeMessage } from '../capabilities.js';
export type { AboutContext } from './about.js';

const ABOUT_TOOL: Tool = {
  name: 'about',
  description:
    'Server metadata, dataset statistics, freshness, and provenance. ' +
    'Call this to verify data coverage, currency, and content basis before relying on results.',
  inputSchema: { type: 'object', properties: {} },
};

const LIST_SOURCES_TOOL: Tool = {
  name: 'list_sources',
  description:
    'Returns detailed provenance metadata for all data sources used by this server. ' +
    'Use this to understand what data is available, its authority, coverage scope, and known limitations. ' +
    'Also returns dataset statistics (document counts, provision counts) and database build timestamp. ' +
    'Call this FIRST when you need to understand what Trinidadian legal data this server covers.',
  inputSchema: { type: 'object', properties: {} },
};

export const TOOLS: Tool[] = [
  {
    name: 'search_legislation',
    description:
      'Search Trinidadian statutes and regulations by keyword using full-text search (FTS5 with BM25 ranking). ' +
      'Returns matching provisions with document context, snippets with >>> <<< markers around matched terms, and relevance scores. ' +
      'Supports FTS5 syntax: quoted phrases ("exact match"), boolean operators (AND, OR, NOT), and prefix wildcards (term*). ' +
      'Results are primarily in English. ' +
      'Default limit is 10 results. For broad topics, increase the limit. ' +
      'Do NOT use this for retrieving a known provision — use get_provision instead.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Search query in English. Supports FTS5 syntax: ' +
            '"exact phrase" for exact phrase, term* for prefix.',
        },
        document_id: {
          type: 'string',
          description: 'Optional: filter results to a specific statute by its document ID.',
        },
        status: {
          type: 'string',
          enum: ['in_force', 'amended', 'repealed'],
          description: 'Optional: filter by legislative status.',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default: 10, max: 50).',
          default: 10,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_provision',
    description:
      'Retrieve the full text of a specific provision (section/article) from a Trinidadian statute. ' +
      'Specify a document_id and optionally a section or provision_ref. ' +
      'Omit section/provision_ref to get ALL provisions in the statute (use sparingly — can be large). ' +
      'Returns provision text, chapter, section number, and metadata. ' +
      'Use this when you know WHICH provision you want. For discovery, use search_legislation instead.',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: {
          type: 'string',
          description: 'Statute identifier: title, short name, or internal document ID.',
        },
        section: {
          type: 'string',
          description: 'Section/article number. Omit to get all provisions.',
        },
        provision_ref: {
          type: 'string',
          description: 'Direct provision reference. Alternative to section parameter.',
        },
      },
      required: ['document_id'],
    },
  },
  {
    name: 'validate_citation',
    description:
      'Validate a Trinidadian legal citation against the database — zero-hallucination check. ' +
      'Parses the citation, checks that the document and provision exist, and returns warnings about status. ' +
      'Use this to verify any citation BEFORE including it in a legal analysis.',
    inputSchema: {
      type: 'object',
      properties: {
        citation: {
          type: 'string',
          description: 'Citation string to validate.',
        },
      },
      required: ['citation'],
    },
  },
  {
    name: 'build_legal_stance',
    description:
      'Build a comprehensive set of citations for a legal question by searching across all Trinidadian statutes simultaneously. ' +
      'Returns aggregated results from multiple relevant provisions. ' +
      'Use this for broad legal questions rather than looking up a specific known provision.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Legal question or topic to research.',
        },
        document_id: {
          type: 'string',
          description: 'Optional: limit search to one statute by document ID.',
        },
        limit: {
          type: 'number',
          description: 'Max results per category (default: 5, max: 20).',
          default: 5,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'format_citation',
    description:
      'Format a Trinidadian legal citation per standard conventions. ' +
      'Three formats: "full" (formal), "short" (abbreviated), "pinpoint" (section reference only).',
    inputSchema: {
      type: 'object',
      properties: {
        citation: { type: 'string', description: 'Citation string to format.' },
        format: {
          type: 'string',
          enum: ['full', 'short', 'pinpoint'],
          description: 'Output format (default: "full").',
          default: 'full',
        },
      },
      required: ['citation'],
    },
  },
  {
    name: 'check_currency',
    description:
      'Check whether a Trinidadian statute or provision is currently in force, amended, or repealed. ' +
      'Returns the document status, issued date, in-force date, and warnings. ' +
      'Essential before citing any provision — always verify currency.',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: {
          type: 'string',
          description: 'Statute identifier.',
        },
        provision_ref: {
          type: 'string',
          description: 'Optional: provision reference to check a specific section.',
        },
      },
      required: ['document_id'],
    },
  },
];

export function buildTools(
  db?: InstanceType<typeof Database>,
  context?: AboutContext,
): Tool[] {
  const tools = [...TOOLS, LIST_SOURCES_TOOL];

  if (context) {
    tools.push(ABOUT_TOOL);
  }

  return tools;
}

export function registerTools(
  server: Server,
  db: InstanceType<typeof Database>,
  context?: AboutContext,
): void {
  const allTools = buildTools(db, context);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: allTools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result: unknown;

      switch (name) {
        case 'search_legislation':
          result = await searchLegislation(db, args as unknown as SearchLegislationInput);
          break;
        case 'get_provision':
          result = await getProvision(db, args as unknown as GetProvisionInput);
          break;
        case 'validate_citation':
          result = await validateCitationTool(db, args as unknown as ValidateCitationInput);
          break;
        case 'build_legal_stance':
          result = await buildLegalStance(db, args as unknown as BuildLegalStanceInput);
          break;
        case 'format_citation':
          result = await formatCitationTool(args as unknown as FormatCitationInput);
          break;
        case 'check_currency':
          result = await checkCurrency(db, args as unknown as CheckCurrencyInput);
          break;
        case 'list_sources':
          result = await listSources(db);
          break;
        case 'about':
          if (context) {
            result = getAbout(db, context);
          } else {
            return {
              content: [{ type: 'text' as const, text: 'About tool not configured.' }],
              isError: true,
            };
          }
          break;
        default:
          return {
            content: [{ type: 'text' as const, text: `Error: Unknown tool "${name}".` }],
            isError: true,
          };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });
}
