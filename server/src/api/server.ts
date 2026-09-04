/**
 * HTTP server bootstrap.
 *
 * Opens (and migrates) the configured SQLite database, selects the payment /
 * LLM adapters from config (simulation + deterministic by default, so the app
 * runs with zero credentials), builds the Express app and starts listening.
 */

import { fileURLToPath } from "node:url";
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
// Compare resolved filesystem paths rather than raw strings so detection works
// on Windows too, where `import.meta.url` is a file:// URL and
// `process.argv[1]` is a native (backslash) path. A direct `===` comparison
// would always be false there and the server would never start.
const isDirectExecution = (): boolean => {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(entry);
};

if (isDirectExecution()) {
  start();
}
