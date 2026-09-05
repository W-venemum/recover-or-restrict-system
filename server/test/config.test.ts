/**
 * Regression tests proving that the canonical repository-root `.env` is loaded
 * based on the config MODULE's own location, not on `process.cwd()`.
 *
 * Historically config.ts used a bare `import "dotenv/config"`, which resolves
 * `.env` from the current working directory. Starting the backend via
 * `npm run dev:server` runs with cwd=server/, so dotenv looked for a
 * nonexistent `server/.env` and missed the real repo-root `.env`. These tests
 * spawn the config module (via the same TS register hook used by dev/seed)
 * from two different working directories and assert the root `.env` is picked
 * up identically in both, without any `server/.env` existing.
 *
 * The tests are deterministic and never hit the network. They also avoid
 * printing or asserting on any secret value (e.g. the OpenRouter API key).
 */

import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync, cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(testDir, ".."); // server/
const repoRoot = path.resolve(serverDir, ".."); // repo root
const registerHook = path.join(serverDir, "src", "register-ts.mjs");

/**
 * Run a tiny inline ES module that imports the config module and prints the
 * requested config field as JSON, with the given cwd. Uses the TS register
 * hook so config.ts runs directly, exactly like `npm run dev:server`/seed.
 */
function loadConfigFrom(cwd: string): {
  port: number;
  databasePath: string;
  openRouterModel: string;
  openRouterBaseUrl: string;
} {
  const configUrl = pathToFileURL(
    path.join(serverDir, "src", "config.ts"),
  ).href;
  const script = [
    `import { loadConfig } from ${JSON.stringify(configUrl)};`,
    `const c = loadConfig();`,
    `process.stdout.write(JSON.stringify({`,
    `  port: c.port,`,
    `  databasePath: c.databasePath,`,
    `  openRouterModel: c.openRouter.model,`,
    `  openRouterBaseUrl: c.openRouter.baseUrl,`,
    `}));`,
  ].join("\n");

  const out = execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      "--import",
      registerHook,
      "--input-type=module",
      "--eval",
      script,
    ],
    { cwd, encoding: "utf8", env: { ...process.env } },
  );
  return JSON.parse(out.trim());
}

describe("config: cwd-independent repo-root .env loading", () => {
  it("has a canonical repo-root .env and no server/.env is required", () => {
    // The canonical file lives at the repo root; server/.env must NOT be needed.
    expect(existsSync(path.join(repoRoot, ".env"))).toBe(true);
    expect(existsSync(path.join(serverDir, ".env"))).toBe(false);
  });

  it("loads identical config whether cwd is server/ or the repo root", () => {
    const fromServer = loadConfigFrom(serverDir);
    const fromRoot = loadConfigFrom(repoRoot);
    expect(fromServer).toEqual(fromRoot);
  });

  it("picks up values from the repo-root .env regardless of cwd", () => {
    // These non-secret values are present in the repo-root .env. If dotenv were
    // (incorrectly) resolving from cwd=server/, no .env would be found there.
    const fromServer = loadConfigFrom(serverDir);
    expect(fromServer.openRouterBaseUrl).toBe("https://openrouter.ai/api/v1");
    expect(fromServer.openRouterModel).toBe("openai/gpt-4o-mini");
    expect(fromServer.port).toBe(4000);
    expect(fromServer.databasePath).toBe("data/app.db");
  });

  it("reads a value that lives ONLY in the root .env, even with cwd=server/ (no server/.env)", () => {
    // Build a throwaway copy of the config module tree plus a root .env that
    // carries a unique sentinel var. Running the copied config with cwd set to
    // the copied server/ dir must still read the sentinel from the copied root
    // .env, proving the load is anchored to the module location, not the cwd.
    // Create the sandbox INSIDE the repo tree so that Node still resolves the
    // `dotenv` dependency from the repo-root node_modules (upward lookup), while
    // the copied config module computes its OWN repo root as the sandbox root
    // (two levels up from the copied server/src). This isolates the .env read
    // from the real repo-root .env.
    const sandbox = mkdtempSync(path.join(repoRoot, ".ror-config-test-"));
    try {
      const sbServerSrc = path.join(sandbox, "server", "src");
      // Copy the runtime hook + config sources needed to run config.ts.
      cpSync(path.join(serverDir, "src"), sbServerSrc, { recursive: true });
      const sentinel = "ROR_TEST_SENTINEL_" + Date.now();
      writeFileSync(
        path.join(sandbox, ".env"),
        `OPENROUTER_MODEL=${sentinel}\n`,
        "utf8",
      );
      // No server/.env in the sandbox.
      expect(existsSync(path.join(sandbox, "server", ".env"))).toBe(false);

      const configUrl = pathToFileURL(
        path.join(sbServerSrc, "config.ts"),
      ).href;
      const script = [
        `import { loadConfig } from ${JSON.stringify(configUrl)};`,
        `process.stdout.write(loadConfig().openRouter.model);`,
      ].join("\n");

      // Ensure the sentinel is not already in the real env (would defeat test).
      const env = { ...process.env };
      delete env.OPENROUTER_MODEL;

      const out = execFileSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--no-warnings",
          "--import",
          path.join(sbServerSrc, "register-ts.mjs"),
          "--input-type=module",
          "--eval",
          script,
        ],
        { cwd: path.join(sandbox, "server"), encoding: "utf8", env },
      );
      expect(out.trim()).toBe(sentinel);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe("config: placeholder OpenRouter key is treated as unset", () => {
  // Use loadConfig(envOverride) with an explicit env object so these tests do
  // not depend on the real repo-root .env and never hit the network.
  it("treats the documented placeholder as absent (OpenRouter disabled, no apiKey)", () => {
    const config = loadConfig({
      OPENROUTER_API_KEY: "PASTE_YOUR_OPENROUTER_API_KEY_HERE",
    } as NodeJS.ProcessEnv);
    expect(config.openRouter.enabled).toBe(false);
    expect(config.openRouter.apiKey).toBeUndefined();
  });

  it("treats a case-varied / lightly-edited PASTE_YOUR placeholder as absent", () => {
    const config = loadConfig({
      OPENROUTER_API_KEY: "paste_your_openrouter_api_key_here",
    } as NodeJS.ProcessEnv);
    expect(config.openRouter.enabled).toBe(false);
    expect(config.openRouter.apiKey).toBeUndefined();
  });

  it("honors a genuine-looking non-placeholder key (OpenRouter enabled, apiKey set)", () => {
    const genuine = "sk-or-v1-0123456789abcdef0123456789abcdef";
    const config = loadConfig({
      OPENROUTER_API_KEY: genuine,
    } as NodeJS.ProcessEnv);
    expect(config.openRouter.enabled).toBe(true);
    expect(config.openRouter.apiKey).toBe(genuine);
  });
});
