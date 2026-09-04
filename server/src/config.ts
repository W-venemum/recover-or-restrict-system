/**
 * Runtime configuration, loaded from environment variables via dotenv.
 *
 * Design rule: the app MUST run fully in a deterministic demo / simulation mode
 * with NO external credentials. This module therefore NEVER throws when
 * OpenRouter or Razorpay keys are absent; it simply reports that those
 * integrations are unavailable so the adapters can degrade to their
 * deterministic / simulation fallbacks.
 */

import "dotenv/config";

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
    const openRouterApiKey = readString("OPENROUTER_API_KEY");
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

    return {
      port: readNumber("PORT", DEFAULT_PORT),
      databasePath: readString("DATABASE_PATH") ?? DEFAULT_DATABASE_PATH,
      openRouter,
      razorpay,
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
