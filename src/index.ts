#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { initializeApp, App } from "firebase-admin/app";
import { getFirestore, Firestore } from "firebase-admin/firestore";

// Config from env
const FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "localhost:8080";
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "demo-project";
const FIREBASE_EMULATOR_HUB = process.env.FIREBASE_EMULATOR_HUB || "localhost:4000";

// Set emulator env before init
process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_EMULATOR_HOST;

let app: App;
let db: Firestore;

function initFirebase() {
  app = initializeApp({ projectId: FIREBASE_PROJECT_ID });
  db = getFirestore(app);
}

// In-memory log buffer (populated by polling emulator)
interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  function?: string;
}

let logBuffer: LogEntry[] = [];
const MAX_LOG_BUFFER = 1000;
let logPollingActive = false;

async function fetchEmulatorLogs(): Promise<LogEntry[]> {
  try {
    const response = await fetch(`http://${FIREBASE_EMULATOR_HUB}/functions/logs`);
    if (!response.ok) return [];
    const data = await response.json();
    return (data.logs || []).map((log: any) => ({
      timestamp: log.timestamp || new Date().toISOString(),
      level: log.level || "INFO",
      message: log.message || log.data || JSON.stringify(log),
      function: log.function || log.functionName,
    }));
  } catch {
    return [];
  }
}

async function fetchLogsFromHub(): Promise<LogEntry[]> {
  try {
    const response = await fetch(`http://${FIREBASE_EMULATOR_HUB}/emulators`);
    if (!response.ok) return [];
    const data = await response.json();
    const functionsEmulator = data.functions;
    if (functionsEmulator?.host && functionsEmulator?.port) {
      const logsResponse = await fetch(
        `http://${functionsEmulator.host}:${functionsEmulator.port}/__/functions/logs`
      );
      if (logsResponse.ok) {
        const logsData = await logsResponse.json();
        return (logsData || []).map((log: any) => ({
          timestamp: log.timestamp || new Date().toISOString(),
          level: log.level || "INFO",
          message: typeof log === "string" ? log : log.message || JSON.stringify(log),
          function: log.function,
        }));
      }
    }
  } catch {
    // Silent fail
  }
  return [];
}

async function pollLogs() {
  if (logPollingActive) return;
  logPollingActive = true;
  
  const logs = await fetchEmulatorLogs();
  if (logs.length === 0) {
    const altLogs = await fetchLogsFromHub();
    logBuffer = [...logBuffer, ...altLogs].slice(-MAX_LOG_BUFFER);
  } else {
    logBuffer = [...logBuffer, ...logs].slice(-MAX_LOG_BUFFER);
  }
  
  logPollingActive = false;
}

setInterval(pollLogs, 2000);

function docToObject(doc: FirebaseFirestore.DocumentSnapshot) {
  if (!doc.exists) return null;
  return {
    id: doc.id,
    path: doc.ref.path,
    data: doc.data(),
  };
}

const tools = [
  {
    name: "list_collections",
    description: "List top-level collections in Firestore",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "list_subcollections",
    description: "List subcollections of a document",
    inputSchema: {
      type: "object" as const,
      properties: {
        documentPath: { type: "string", description: "Full document path (e.g., 'users/user123')" },
      },
      required: ["documentPath"],
    },
  },
  {
    name: "list_documents",
    description: "List documents in a collection with optional limit",
    inputSchema: {
      type: "object" as const,
      properties: {
        collectionPath: { type: "string", description: "Collection path (e.g., 'users' or 'users/user123/orders')" },
        limit: { type: "number", description: "Max documents to return (default: 20)" },
      },
      required: ["collectionPath"],
    },
  },
  {
    name: "get_document",
    description: "Get a single document by path",
    inputSchema: {
      type: "object" as const,
      properties: {
        documentPath: { type: "string", description: "Full document path (e.g., 'users/user123')" },
      },
      required: ["documentPath"],
    },
  },
  {
    name: "query_collection",
    description: "Query a collection with filters",
    inputSchema: {
      type: "object" as const,
      properties: {
        collectionPath: { type: "string", description: "Collection path" },
        filters: {
          type: "array",
          description: "Array of filter objects: {field, operator, value}",
          items: {
            type: "object",
            properties: {
              field: { type: "string" },
              operator: { type: "string", enum: ["==", "!=", "<", "<=", ">", ">=", "array-contains", "in", "array-contains-any"] },
              value: {},
            },
            required: ["field", "operator", "value"],
          },
        },
        orderBy: { type: "string", description: "Field to order by" },
        orderDirection: { type: "string", enum: ["asc", "desc"] },
        limit: { type: "number", description: "Max documents to return (default: 20)" },
      },
      required: ["collectionPath"],
    },
  },
  {
    name: "get_function_logs",
    description: "Get Firebase function logs with optional grep-style filtering",
    inputSchema: {
      type: "object" as const,
      properties: {
        pattern: { type: "string", description: "Regex pattern to filter log messages" },
        level: { type: "string", enum: ["DEBUG", "INFO", "WARN", "ERROR"], description: "Filter by log level" },
        functionName: { type: "string", description: "Filter by function name" },
        limit: { type: "number", description: "Max log entries to return (default: 50)" },
        since: { type: "string", description: "ISO timestamp - only logs after this time" },
      },
    },
  },
];

async function handleListCollections() {
  const collections = await db.listCollections();
  return collections.map((col) => col.id);
}

async function handleListSubcollections(documentPath: string) {
  const docRef = db.doc(documentPath);
  const collections = await docRef.listCollections();
  return collections.map((col) => col.id);
}

async function handleListDocuments(collectionPath: string, limit = 20) {
  const snapshot = await db.collection(collectionPath).limit(limit).get();
  return snapshot.docs.map(docToObject);
}

async function handleGetDocument(documentPath: string) {
  const doc = await db.doc(documentPath).get();
  return docToObject(doc);
}

interface QueryFilter {
  field: string;
  operator: FirebaseFirestore.WhereFilterOp;
  value: any;
}

async function handleQueryCollection(
  collectionPath: string,
  filters?: QueryFilter[],
  orderBy?: string,
  orderDirection?: "asc" | "desc",
  limit = 20
) {
  let query: FirebaseFirestore.Query = db.collection(collectionPath);
  if (filters) {
    for (const filter of filters) {
      query = query.where(filter.field, filter.operator, filter.value);
    }
  }
  if (orderBy) {
    query = query.orderBy(orderBy, orderDirection || "asc");
  }
  query = query.limit(limit);
  const snapshot = await query.get();
  return snapshot.docs.map(docToObject);
}

async function handleGetFunctionLogs(
  pattern?: string,
  level?: string,
  functionName?: string,
  limit = 50,
  since?: string
) {
  await pollLogs();
  let filtered = [...logBuffer];
  if (since) {
    const sinceTime = new Date(since).getTime();
    filtered = filtered.filter((log) => new Date(log.timestamp).getTime() >= sinceTime);
  }
  if (level) {
    filtered = filtered.filter((log) => log.level.toUpperCase() === level.toUpperCase());
  }
  if (functionName) {
    filtered = filtered.filter((log) => log.function?.includes(functionName));
  }
  if (pattern) {
    const regex = new RegExp(pattern, "i");
    filtered = filtered.filter((log) => regex.test(log.message));
  }
  return filtered.slice(-limit);
}

async function main() {
  initFirebase();

  const server = new Server(
    { name: "firebase-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      let result: any;
      switch (name) {
        case "list_collections":
          result = await handleListCollections();
          break;
        case "list_subcollections":
          result = await handleListSubcollections(args?.documentPath as string);
          break;
        case "list_documents":
          result = await handleListDocuments(args?.collectionPath as string, args?.limit as number);
          break;
        case "get_document":
          result = await handleGetDocument(args?.documentPath as string);
          break;
        case "query_collection":
          result = await handleQueryCollection(
            args?.collectionPath as string,
            args?.filters as QueryFilter[],
            args?.orderBy as string,
            args?.orderDirection as "asc" | "desc",
            args?.limit as number
          );
          break;
        case "get_function_logs":
          result = await handleGetFunctionLogs(
            args?.pattern as string,
            args?.level as string,
            args?.functionName as string,
            args?.limit as number,
            args?.since as string
          );
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Firebase MCP Server running on stdio");
}

main().catch(console.error);
