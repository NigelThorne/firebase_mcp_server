#!/usr/bin/env node
import WebSocket from "ws";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { initializeApp, App } from "firebase-admin/app";
import { getFirestore, Firestore } from "firebase-admin/firestore";
import { getAuth, Auth } from "firebase-admin/auth";

// Config from env
const FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "localhost:8080";
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "demo-project";
const FIREBASE_EMULATOR_HUB = process.env.FIREBASE_EMULATOR_HUB || "localhost:4000";
const AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "localhost:9099";

// Set emulator env before init
process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_EMULATOR_HOST;
process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_EMULATOR_HOST;

let app: App;
let db: Firestore;
let adminAuth: Auth;

function initFirebase() {
  app = initializeApp({ projectId: FIREBASE_PROJECT_ID });
  db = getFirestore(app);
  adminAuth = getAuth(app);
}

// In-memory log buffer (populated via WebSocket from emulator hub)
interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  function?: string;
}

let logBuffer: LogEntry[] = [];

const MAX_LOG_BUFFER = 1000;



function connectToEmulatorLogs() {
  const wsUrl = `ws://${FIREBASE_EMULATOR_HUB}`;
  let ws: WebSocket;
  let reconnectTimeout: NodeJS.Timeout | null = null;

  function connect() {
    ws = new WebSocket(wsUrl);

    ws.on("open", () => {
      console.error(`Connected to emulator hub WebSocket at ${wsUrl}`);
    });

    ws.on("message", (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        // Hub sends log entries with structure like:
        // { type: "functions-log", data: { timestamp, level, message, ... } }
        // or { origin: "functions", ... }
        const entry = parseLogMessage(msg);
        if (entry) {
          logBuffer.push(entry);
          if (logBuffer.length > MAX_LOG_BUFFER) {
            logBuffer = logBuffer.slice(-MAX_LOG_BUFFER);
          }
        }
      } catch {
        // Ignore unparseable messages
      }
    });

    ws.on("close", () => {
      console.error("Emulator hub WebSocket closed, reconnecting in 3s...");
      scheduleReconnect();
    });

    ws.on("error", () => {
      // Will trigger close event, which handles reconnect
    });
  }

  function scheduleReconnect() {
    if (reconnectTimeout) return;
    reconnectTimeout = setTimeout(() => {
      reconnectTimeout = null;
      connect();
    }, 3000);
  }

  connect();
}

function parseLogMessage(msg: any): LogEntry | null {
  // Shape: { level, data: { metadata: { emulator, function, message } }, timestamp, message }
  const metadata = msg.data?.metadata || {};
  const functionName = metadata.function?.name;
  const emulator = metadata.emulator?.name;

  const text = msg.message;
  if (!text) return null;

  const message = typeof text === "string" ? text : JSON.stringify(text);
  // Strip ANSI escape codes
  const cleanMessage = message.replace(/\x1b\[[0-9;]*m/g, "").trim();
  if (!cleanMessage) return null;

  return {
    timestamp: msg.timestamp || new Date().toISOString(),
    level: msg.level?.toUpperCase() || "INFO",
    message: cleanMessage,
    function: functionName || emulator || undefined,
  };
}

connectToEmulatorLogs();

function docToObject(doc: FirebaseFirestore.DocumentSnapshot) {
  if (!doc.exists) return null;
  return {
    id: doc.id,
    path: doc.ref.path,
    data: doc.data(),
  };
}

function handleGetEnvironment() {
  return {
    type: "emulator",
    projectId: FIREBASE_PROJECT_ID,
    firestoreHost: FIRESTORE_EMULATOR_HOST,
    emulatorHub: FIREBASE_EMULATOR_HUB,
    note: "This is a local emulator environment - safe for testing",
  };
}

const tools = [
  {
    name: "get_environment",
    description: "Get information about the current Firebase environment",
    inputSchema: { type: "object" as const, properties: {} },
  },
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
    name: "list_functions",
    description: "List all Cloud Functions registered in the emulator",
    inputSchema: { type: "object" as const, properties: {} },
  },

  {
    name: "get_auth_token",
    description: "Get an ID token for a user in the Auth emulator. Lists users if no uid provided.",
    inputSchema: {
      type: "object" as const,
      properties: {
        uid: { type: "string", description: "User UID. If omitted, lists available users instead." },
      },
    },
  },
  {
    name: "get_function_logs",
    description: "Get Firebase function logs. Returns 20 lines by default - use filters (pattern, level, functionName) to narrow results before increasing limit.",
    inputSchema: {
      type: "object" as const,
      properties: {
        pattern: { type: "string", description: "Regex pattern to filter log messages" },
        level: { type: "string", enum: ["DEBUG", "INFO", "WARN", "ERROR"], description: "Filter by log level" },
        functionName: { type: "string", description: "Filter by function name" },
        limit: { type: "number", description: "Max log entries to return (default: 20)" },
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
  limit = 20,
  since?: string
) {
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

async function handleGetAuthToken(uid?: string) {
  if (!uid) {
    // List users so the caller can pick one
    const result = await adminAuth.listUsers(20);
    return {
      message: "No uid provided. Available users:",
      users: result.users.map((u) => ({
        uid: u.uid,
        email: u.email || undefined,
        displayName: u.displayName || undefined,
      })),
    };
  }

  // Create a custom token and exchange it for an ID token via the emulator REST API
  const customToken = await adminAuth.createCustomToken(uid);
  const resp = await fetch(
    `http://${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-api-key`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    }
  );
  const data = await resp.json();
  if (!data.idToken) {
    throw new Error(`Failed to get ID token: ${JSON.stringify(data)}`);
  }
  return { uid, idToken: data.idToken };
}

async function handleListFunctions() {
  try {
    const response = await fetch(`http://${FIREBASE_EMULATOR_HUB}/emulators`);
    if (!response.ok) return [];
    const data = await response.json();
    const functionsEmulator = data.functions;
    if (!functionsEmulator) return [];

    // Try to get function list from emulator
    const functionsUrl = `http://${functionsEmulator.host || 'localhost'}:${functionsEmulator.port}/__/functions/list`;
    const fnResponse = await fetch(functionsUrl);
    if (fnResponse.ok) {
      const fnData = await fnResponse.json();
      return (fnData.functions || []).map((fn: any) => ({
        name: fn.name || fn.id,
        trigger: fn.trigger?.httpsTrigger ? "https" : fn.trigger?.eventTrigger?.eventType || "unknown",
        region: fn.region || "us-central1",
      }));
    }

    // Fallback: extract unique function names from logs
    const uniqueFunctions = [...new Set(logBuffer.map(l => l.function).filter(Boolean))];
    return uniqueFunctions.map(name => ({ name, trigger: "unknown", region: "unknown" }));
  } catch {
    return [];
  }
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
        case "get_environment":
          result = handleGetEnvironment();
          break;
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
        case "get_auth_token":
          result = await handleGetAuthToken(args?.uid as string | undefined);
          break;
        case "list_functions":
          result = await handleListFunctions();
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
