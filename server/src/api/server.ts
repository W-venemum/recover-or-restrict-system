/**
 * HTTP server bootstrap.
 *
 * Opens (and migrates) the configured SQLite database, selects the payment /
 * LLM adapters from config (simulation + deterministic by default, so the app
 * runs with zero credentials), builds the Express app and starts listening.
 */

import { pathToFileURL } from "node:url";
import path from "node:path";
import type { Express } from "express";
import { createPaymentAdapter } from "../adapters/razorpay.js";
import { createLlmAdapter } from "../adapters/openrouter.js";
import type { AppConfig } from "../config.js";
import { getConfig } from "../config.js";
import type { DB } from "../db/migrate.js";
import { openDatabase } from "../db/migrate.js";
import { Repository } from "../db/repo.js";
import { createApp } from "./app.js";

export interface BuiltServer {
  app: Express;
  config: AppConfig;
  db: DB;
}

export function buildServer(): BuiltServer {
  const config = getConfig();
  const db = openDatabase(config.databasePath);
  const repo = new Repository(db);
  const paymentAdapter = createPaymentAdapter(config.razorpay);
  const llmAdapter = createLlmAdapter(config.openRouter);
  const app = createApp({
    repo,
    paymentAdapter,
    llmAdapter,
    ...(config.reviewSecret ? { reviewSecret: config.reviewSecret } : {}),
  });
  return { app, config, db };
}

export function start(): void {
  const { app, config } = buildServer();
  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `Recover-or-Restrict API listening on http://localhost:${config.port} ` +
        `(payments: ${config.razorpay.mode})`,
    );
  });
}

// Start when executed directly (both raw `.ts` via node and compiled `dist`).
//
// Detection normalises BOTH sides to a canonical `file://` URL and compares
// those, rather than comparing raw strings or resolved native paths. This is
// the robust cross-platform idiom:
//   - `process.argv[1]` is a native filesystem path (backslashes on Windows,
//     and possibly a relative path, since the dev script invokes
//     `... src/api/server.ts`). `path.resolve` makes it absolute and
//     `pathToFileURL(...).href` encodes it exactly the way Node builds
//     `import.meta.url` (forward slashes, percent-encoding, `file:///C:/...`).
//   - Comparing native paths with `===` is fragile on Windows because the
//     drive letter case can differ (`C:\` vs `c:\`) and because the module may
//     be resolved through a custom loader hook whose URL casing/format need
//     not match `argv[1]` byte-for-byte. Comparing canonical file URLs avoids
//     both the separator and drive-case pitfalls.
const isDirectExecution = (): boolean => {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
};

if (isDirectExecution()) {
  start();
}
