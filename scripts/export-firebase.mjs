/**
 * Exports the legacy Firestore collections to local JSON before the project is
 * decommissioned.
 *
 * The transcripts are the only thing in `resqai-4700b` worth keeping: real
 * phrasing from real Indian emergency calls, which is useful as seed data for
 * M2 and as a starting point for the M6 evaluation set. Everything else is
 * superseded.
 *
 * Usage — from a machine with credentials for the project:
 *
 *   export FIREBASE_ADMIN_CREDENTIALS="$(cat service-account.json)"
 *   node scripts/export-firebase.mjs
 *
 * or:
 *
 *   export GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
 *   node scripts/export-firebase.mjs
 *
 * Writes to data/legacy/. Reads only — it never modifies the source project,
 * so deletion stays a deliberate manual step in the Firebase console.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/*
 * firebase-admin is already committed under the legacy backend, so this looks
 * there before asking for an install. That directory is on its way out, but
 * while it exists there is no reason to make someone download a second copy of
 * a package the repository already contains.
 */
let admin;
for (const specifier of ["firebase-admin", "../backend/node_modules/firebase-admin"]) {
  try {
    admin = require(specifier);
    break;
  } catch {
    // Try the next location.
  }
}

if (!admin) {
  console.error(
    "firebase-admin not found. From the repo root:\n" +
      "  npm install firebase-admin --no-save",
  );
  process.exit(1);
}

const OUT_DIR = "data/legacy";
const COLLECTIONS = ["call_transcripts", "emergencies"];

function initialise() {
  const inline = process.env.FIREBASE_ADMIN_CREDENTIALS;
  if (inline) {
    let parsed;
    try {
      parsed = JSON.parse(inline);
    } catch (err) {
      throw new Error(
        `FIREBASE_ADMIN_CREDENTIALS is set but is not valid JSON: ${err.message}`,
      );
    }
    return admin.initializeApp({ credential: admin.credential.cert(parsed) });
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
  }

  throw new Error(
    "No credentials. Set FIREBASE_ADMIN_CREDENTIALS (the service-account JSON) " +
      "or GOOGLE_APPLICATION_CREDENTIALS (a path to it).",
  );
}

/** Firestore Timestamps do not survive JSON.stringify; convert them to ISO strings. */
function normalise(value) {
  if (value === null || value === undefined) return value;
  if (typeof value?.toDate === "function") return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(normalise);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalise(v)]),
    );
  }
  return value;
}

async function main() {
  initialise();
  const db = admin.firestore();
  await mkdir(OUT_DIR, { recursive: true });

  const summary = [];

  for (const name of COLLECTIONS) {
    process.stdout.write(`exporting ${name} … `);
    const snapshot = await db.collection(name).get();

    const docs = snapshot.docs.map((doc) => ({
      id: doc.id,
      data: normalise(doc.data()),
    }));

    const path = `${OUT_DIR}/${name}.json`;
    await writeFile(path, JSON.stringify(docs, null, 2), "utf8");

    console.log(`${docs.length} document(s) -> ${path}`);
    summary.push({ collection: name, count: docs.length });
  }

  // A rough count of usable transcript turns, which is what actually matters
  // for seeding M2 and M6 — document count alone overstates it.
  const transcripts = summary.find((s) => s.collection === "call_transcripts");
  if (transcripts?.count) {
    console.log(
      `\n${transcripts.count} transcript document(s) exported. ` +
        `Review data/legacy/call_transcripts.json before deleting the project.`,
    );
  } else {
    console.log(
      "\nNo transcripts found. Nothing here is worth keeping — " +
        "the project can be deleted directly.",
    );
  }

  console.log(
    "\nThis script only reads. Delete the project from the Firebase console " +
      "once you have checked the export.",
  );
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exitCode = 1;
});
