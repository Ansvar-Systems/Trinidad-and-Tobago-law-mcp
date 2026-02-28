# Trinidad and Tobago Law MCP

MCP server providing access to Trinidad and Tobago legislation with full-text search, provision retrieval, and citation validation.

## Features

- **8 core tools**: search_legislation, get_provision, validate_citation, build_legal_stance, format_citation, check_currency, list_sources, about
- **FTS5 full-text search** with BM25 relevance ranking
- **Zero-hallucination citation validation**
- **Streamable HTTP** (Vercel) + **stdio** (npm) transports

## Quick Start

### Remote (Streamable HTTP)

```json
{
  "mcpServers": {
    "trinidadian-law-mcp": {
      "url": "https://trinidadian-law-mcp.vercel.app/mcp"
    }
  }
}
```

### Local (stdio via npx)

```json
{
  "mcpServers": {
    "trinidadian-law-mcp": {
      "command": "npx",
      "args": ["-y", "@ansvar/trinidadian-law-mcp"]
    }
  }
}
```

## Data Source

- **Source**: [laws.gov.tt](https://laws.gov.tt)
- **Language**: English
- **Jurisdiction**: Trinidad and Tobago (TT)

## Development

```bash
npm install
npm run census        # Enumerate laws from source
npm run ingest        # Download and parse law texts
npm run build:db      # Compile SQLite database
npm run build         # Compile TypeScript
npm test              # Run tests
```

## License

Apache-2.0 -- see [LICENSE](LICENSE)

## Disclaimer

See [DISCLAIMER.md](DISCLAIMER.md). This tool is for informational purposes only and does not constitute legal advice.
