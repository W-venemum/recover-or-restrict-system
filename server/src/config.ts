/**
 * Runtime configuration, loaded from environment variables via dotenv.
 *
 * Design rule: the app MUST run fully in a deterministic demo / simulation mode
 * with NO external credentials. This module therefore NEVER throws when
 * OpenRouter or Razorpay keys are absent; it simply reports that those
 * integrations are unavailable so the adapters can degrade to their
 * deterministic / simulation fallbacks.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

/**
 * Load the single canonical `.env` at the repository root, regardless of the
 * current working directory.
 *
 * The bug this fixes: a bare `import "dotenv/config"` resolves `.env` from
 * `process.cwd()`. When the server is started via `npm run dev:server` the cwd
 * is `server/`, so dotenv looked for a nonexistent `server/.env` and missed the
 * canonical repo-root `.env`.
 *
 * The fix: resolve the `.env` path from THIS module's location rather than the
 * cwd. At runtime this module lives at either `server/src/config.ts` (run
 * directly via the TS register hook) or `server/dist/config.js` (compiled). In
 * both cases the repository root is exactly two directory levels up
 * (server/src -> server -> root, and server/dist -> server -> root). This makes
 * configuration loading robust and cross-platform.
 *
 * Standard dotenv precedence is preserved: real variables already present in
 * `process.env` are NOT overridden by the file (no `override: true`).
 */
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRootEnvPath = path.resolve(moduleDir, "..", "..", ".env");
dotenv.config({ path: repoRootEnvPath });

export type RazorpayMode = "simulation" | "live";

export interface OpenRouterConfig {
  /** Present only when an API key is configured. */
  apiKey?: string;
  model: string;
  baseUrl: string;
  /** Convenience flag: true when an API key is present. */
  enabled: boolean;
}

export interface RazorpayConfig {
  keyId?: string;
  keySecret?: string;
  webhookSecret?: string;
  /** 'simulation' (default) generates demo events; 'live' uses real webhooks. */
  mode: RazorpayMode;
}

export interface AppConfig {
  port: number;
  databasePath: string;
  openRouter: OpenRouterConfig;
  razorpay: RazorpayConfig;
  /**
   * Optional shared secret guarding the mutating endpoints (merchant review /
   * explain). Absent by default so the demo runs open; when set, those routes
   * require the secret. Never throws when missing.
   */
  reviewSecret?: string;
}

function readString(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNumber(name: string, fallback: number): number {
  const raw = readString(name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * The documented placeholder shipped in `.env.example` (and the repo-root
 * `.env`) for the OpenRouter key. It is NOT a real credential: it exists only
 * to show operators where to paste their own key. If left in place it must be
 * treated as UNSET so the app keeps its zero-config, fully deterministic demo
 * default (README promise: "with none set the app runs fully in deterministic
 * demo/simulation mode"). A genuine key is still honored unchanged.
 */
const OPENROUTER_API_KEY_PLACEHOLDER = "PASTE_YOUR_OPENROUTER_API_KEY_HERE";

/**
 * Return true when an OpenRouter API key value is an obvious unset/placeholder
 * rather than a real credential. Matches the documented sentinel exactly
 * (case-insensitive) and also any value still carrying the "PASTE_YOUR"
 * substring, so a lightly-edited placeholder is still treated as absent.
 */
function isPlaceholderOpenRouterKey(value: string): boolean {
  const normalised = value.trim().toLowerCase();
  return normalised === OPENROUTER_API_KEY_PLACEHOLDER.toLowerCase();
}

/** A real, current OpenRouter model id used as the sensible default. */
const DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o-mini";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_DATABASE_PATH = "data/app.db";
const DEFAULT_PORT = 4000;

/**
 * Build the application config from `process.env`. Pure with respect to the
 * environment: given the same env, returns the same config. Never throws for
 * missing optional integration credentials.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const prev = { ...process.env };
  // Point the readers at the supplied env for the duration of this call while
  // keeping the common path (env === process.env) a no-op.
  if (env !== process.env) {
    Object.assign(process.env, env);
  }
  try {
    const rawOpenRouterApiKey = readString("OPENROUTER_API_KEY");
    // Treat the documented placeholder as absent so the shipped `.env` /
    // `.env.example` default keeps the pure deterministic demo posture instead
    // of selecting OpenRouter and 401ing on every /explain call. A real key is
    // honored unchanged.
    const openRouterApiKey =
      rawOpenRouterApiKey && isPlaceholderOpenRouterKey(rawOpenRouterApiKey)
        ? undefined
        : rawOpenRouterApiKey;
    const razorpayModeRaw = (readString("RAZORPAY_MODE") ?? "simulation").toLowerCase();
    const razorpayMode: RazorpayMode = razorpayModeRaw === "live" ? "live" : "simulation";

    const openRouter: OpenRouterConfig = {
      ...(openRouterApiKey ? { apiKey: openRouterApiKey } : {}),
      model: readString("OPENROUTER_MODEL") ?? DEFAULT_OPENROUTER_MODEL,
      baseUrl: readString("OPENROUTER_BASE_URL") ?? DEFAULT_OPENROUTER_BASE_URL,
      enabled: openRouterApiKey !== undefined,
    };

    const razorpay: RazorpayConfig = {
      ...(readString("RAZORPAY_KEY_ID") ? { keyId: readString("RAZORPAY_KEY_ID") } : {}),
      ...(readString("RAZORPAY_KEY_SECRET")
        ? { keySecret: readString("RAZORPAY_KEY_SECRET") }
        : {}),
      ...(readString("RAZORPAY_WEBHOOK_SECRET")
        ? { webhookSecret: readString("RAZORPAY_WEBHOOK_SECRET") }
        : {}),
      mode: razorpayMode,
    };

    const reviewSecret = readString("REVIEW_SECRET");

    return {
      port: readNumber("PORT", DEFAULT_PORT),
      databasePath: readString("DATABASE_PATH") ?? DEFAULT_DATABASE_PATH,
      openRouter,
      razorpay,
      ...(reviewSecret ? { reviewSecret } : {}),
    };
  } finally {
    if (env !== process.env) {
      // Restore process.env to avoid leaking the injected env.
      for (const key of Object.keys(process.env)) {
        if (!(key in prev)) delete process.env[key];
      }
      Object.assign(process.env, prev);
    }
  }
}

/** Lazily-created shared config instance. */
let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}
