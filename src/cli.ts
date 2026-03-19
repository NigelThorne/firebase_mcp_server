#!/usr/bin/env node
import { initializeApp, App } from "firebase-admin/app";
import { getFirestore, Firestore } from "firebase-admin/firestore";
import { getAuth, Auth } from "firebase-admin/auth";

// --- Config ---
const FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "localhost:8080";
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "patientnotes-dev";
const FIREBASE_EMULATOR_HUB = process.env.FIREBASE_EMULATOR_HUB || "localhost:4000";
const AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "localhost:9099";

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

function docToObject(doc: FirebaseFirestore.DocumentSnapshot) {
  if (!doc.exists) return null;
  return { id: doc.id, path: doc.ref.path, data: doc.data() };
}

// --- Handlers ---

function handleGetEnvironment() {
  return {
    type: "emulator",
    projectId: FIREBASE_PROJECT_ID,
    firestoreHost: FIRESTORE_EMULATOR_HOST,
    emulatorHub: FIREBASE_EMULATOR_HUB,
    note: "This is a local emulator environment - safe for testing",
  };
}

async function handleListCollections() {
  return (await db.listCollections()).map((c) => c.id);
}

async function handleListSubcollections(documentPath: string) {
  return (await db.doc(documentPath).listCollections()).map((c) => c.id);
}

async function handleListDocuments(collectionPath: string, limit = 20) {
  const snap = await db.collection(collectionPath).limit(limit).get();
  return snap.docs.map(docToObject);
}

async function handleGetDocument(documentPath: string) {
  return docToObject(await db.doc(documentPath).get());
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
    for (const f of filters) query = query.where(f.field, f.operator, f.value);
  }
  if (orderBy) query = query.orderBy(orderBy, orderDirection || "asc");
  query = query.limit(limit);
  return (await query.get()).docs.map(docToObject);
}

async function handleListFunctions() {
  try {
    const response = await fetch(`http://${FIREBASE_EMULATOR_HUB}/emulators`);
    if (!response.ok) return [];
    const data = await response.json();
    const functionsEmulator = data.functions;
    if (!functionsEmulator) return [];

    const functionsUrl = `http://${functionsEmulator.host || "localhost"}:${functionsEmulator.port}/__/functions/list`;
    const fnResponse = await fetch(functionsUrl);
    if (fnResponse.ok) {
      const fnData = await fnResponse.json();
      return (fnData.functions || []).map((fn: any) => ({
        name: fn.name || fn.id,
        trigger: fn.trigger?.httpsTrigger ? "https" : fn.trigger?.eventTrigger?.eventType || "unknown",
        region: fn.region || "us-central1",
      }));
    }
    return [];
  } catch {
    return [];
  }
}

async function handleGetAuthToken(uid?: string) {
  if (!uid) {
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
  if (!data.idToken) throw new Error(`Failed to get ID token: ${JSON.stringify(data)}`);
  return { uid, idToken: data.idToken };
}

async function handleGetFunctionLogs(
  pattern?: string,
  level?: string,
  functionName?: string,
  limit = 20,
  since?: string
) {
  // For CLI mode, we fetch logs from the emulator hub's logging endpoint
  // since we don't have the persistent WebSocket buffer
  try {
    const response = await fetch(`http://${FIREBASE_EMULATOR_HUB}/emulators`);
    if (!response.ok) return { logs: [], note: "Could not connect to emulator hub" };
    const emulators = await response.json();
    const loggingPort = emulators.logging?.port;

    // Try the hub's logging endpoint
    const logUrl = `http://${FIREBASE_EMULATOR_HUB.split(":")[0]}:${loggingPort || FIREBASE_EMULATOR_HUB.split(":")[1]}/`;
    // The emulator hub doesn't have a REST log query API, so we'll note this limitation
    return {
      logs: [],
      note: "Function logs require the MCP server's WebSocket connection to the emulator hub. " +
            "The CLI can query Firestore and Auth but cannot retrieve buffered logs. " +
            "Use 'firebase emulators:start' terminal output or the Emulator UI for logs.",
    };
  } catch {
    return { logs: [], note: "Could not connect to emulator hub for logs" };
  }
}

// --- CLI arg parsing ---

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const command = args[0];
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const val = args[i + 1];
      if (val && !val.startsWith("--")) {
        flags[key] = val;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(args[i]);
    }
  }
  return { command, positional, flags };
}

function printJSON(data: any) {
  console.log(JSON.stringify(data, null, 2));
}

const USAGE = `
firebase-emu-cli - Query Firebase Emulator (Firestore + Auth)

Usage:
  firebase-emu-cli <command> [args] [options]

Commands:
  env                              Show environment info
  collections                      List top-level Firestore collections
  subcollections <documentPath>    List subcollections of a document
  documents <collectionPath>       List documents in a collection
    --limit <N>                      Max documents (default: 20)
  doc <documentPath>               Get a single document
  query <collectionPath>           Query a collection with filters
    --filter <json>                  JSON array of {field, operator, value}
    --order-by <field>               Field to order by
    --order-dir <asc|desc>           Order direction
    --limit <N>                      Max documents (default: 20)
  functions                        List emulator Cloud Functions
  auth-token [uid]                 Get auth token for user (lists users if no uid)
  logs                             Get function logs (limited in CLI mode)
    --pattern <regex>                Filter log messages by regex
    --level <level>                  Filter by level (DEBUG|INFO|WARN|ERROR)
    --function <name>                Filter by function name
    --limit <N>                      Max entries (default: 20)
    --since <ISO timestamp>          Only logs after this time

Environment:
  FIREBASE_PROJECT_ID              Project ID (default: demo-project)
  FIRESTORE_EMULATOR_HOST          Firestore host (default: localhost:8080)
  FIREBASE_AUTH_EMULATOR_HOST      Auth host (default: localhost:9099)
  FIREBASE_EMULATOR_HUB            Hub host (default: localhost:4000)
`.trim();

async function main() {
  const { command, positional, flags } = parseArgs(process.argv);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    process.exit(0);
  }

  initFirebase();

  try {
    switch (command) {
      case "env":
        printJSON(handleGetEnvironment());
        break;

      case "collections":
        printJSON(await handleListCollections());
        break;

      case "subcollections": {
        const docPath = positional[0];
        if (!docPath) { console.error("Error: documentPath required"); process.exit(1); }
        printJSON(await handleListSubcollections(docPath));
        break;
      }

      case "documents": {
        const colPath = positional[0];
        if (!colPath) { console.error("Error: collectionPath required"); process.exit(1); }
        printJSON(await handleListDocuments(colPath, flags.limit ? parseInt(flags.limit) : undefined));
        break;
      }

      case "doc": {
        const docPath = positional[0];
        if (!docPath) { console.error("Error: documentPath required"); process.exit(1); }
        printJSON(await handleGetDocument(docPath));
        break;
      }

      case "query": {
        const colPath = positional[0];
        if (!colPath) { console.error("Error: collectionPath required"); process.exit(1); }
        const filters = flags.filter ? JSON.parse(flags.filter) : undefined;
        printJSON(await handleQueryCollection(
          colPath,
          filters,
          flags["order-by"],
          flags["order-dir"] as "asc" | "desc" | undefined,
          flags.limit ? parseInt(flags.limit) : undefined,
        ));
        break;
      }

      case "functions":
        printJSON(await handleListFunctions());
        break;

      case "auth-token":
        printJSON(await handleGetAuthToken(positional[0]));
        break;

      case "logs":
        printJSON(await handleGetFunctionLogs(
          flags.pattern,
          flags.level,
          flags.function,
          flags.limit ? parseInt(flags.limit) : undefined,
          flags.since,
        ));
        break;

      default:
        console.error(`Unknown command: ${command}`);
        console.log(USAGE);
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  process.exit(0);
}

main();
