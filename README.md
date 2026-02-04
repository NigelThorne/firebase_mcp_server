# Firebase MCP Server

MCP server for inspecting Firebase Emulator Firestore and function logs.

## Setup

```bash
npm install
npm run build
```

## Config

Copy `.env.example` to `.env` and adjust:

```
FIRESTORE_EMULATOR_HOST=localhost:8080
FIREBASE_PROJECT_ID=demo-project
FIREBASE_EMULATOR_HUB=localhost:4000
```

## Usage with Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "firebase": {
      "command": "node",
      "args": ["/path/to/firebase_mcp_server/dist/index.js"],
      "env": {
        "FIRESTORE_EMULATOR_HOST": "localhost:8080",
        "FIREBASE_PROJECT_ID": "your-project-id",
        "FIREBASE_EMULATOR_HUB": "localhost:4000"
      }
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `list_collections` | List top-level Firestore collections |
| `list_subcollections` | List subcollections of a document |
| `list_documents` | List documents in a collection |
| `get_document` | Get a single document by path |
| `query_collection` | Query with filters, ordering, limit |
| `get_function_logs` | Get function logs with grep-style filtering |

### get_function_logs options

- `pattern` - Regex to filter log messages
- `level` - DEBUG/INFO/WARN/ERROR
- `functionName` - Filter by function name
- `limit` - Max entries (default 50)
- `since` - ISO timestamp cutoff

