# Recover-or-Restrict System

A subscription **revenue-recovery** and **trust / access decision** engine for a
merchant. For each customer it decides whether to **RECOVER**, **INTERVENE**,
**RESTRICT**, or **SUSPEND**, chooses a next-best recovery action, and drives an
adaptive access state, using transparent, deterministic, rules-based logic with
weighted, recency-decayed risk scoring.

> **What is and isn't "AI" here.** The core financial, risk and decision logic
> is fully deterministic, rules-based and explainable. It never depends on an
> LLM. An optional LLM (via OpenRouter) is used **only** to phrase
> human-readable explanation and recovery-message text, and it always has a
> deterministic fallback. There is no machine-learning model and no training.
> The Razorpay integration runs in **simulation mode** by default; no live
> gateway account is required to run or demo the app.

## Product principle

A single normal or transient payment failure must **not** automatically damage
trust or lead to restriction. Genuine payment trouble is **recovered**;
deliberate behavioural avoidance or value-extraction is **restricted** or
**suspended**. Blacklisting is only ever a **recommendation** surfaced for human
review — it is never applied automatically by the engine.

## Architecture

This is an npm-workspaces monorepo (`server`, `web`).

```
recover-or-restrict-system/
├── server/           Node + Express + TypeScript backend
│   └── src/
│       ├── domain/    Pure domain types + events (no I/O)
│       ├── engine/    Deterministic decision engine (pure functions)
│       ├── adapters/  Razorpay + OpenRouter behind interfaces (simulation/fallback)
│       ├── db/         better-sqlite3 persistence (schema, migrate, repo)
│       ├── api/        Express app factory + REST routes + webhook
│       └── seed/       7-scenario demo data (evaluated through the real engine)
├── web/              React + Vite + TypeScript merchant dashboard
│   └── src/
│       ├── api/        Typed fetch client + response types
│       ├── components/ Small shared UI (badges, bars)
│       ├── pages/      Dashboard, Customer list, Customer detail
│       └── lib/        Formatting, color-coding, hash router, data hook
├── data/             SQLite database file (gitignored; created by seed/migrate)
├── .env.example      Copy to .env; all vars optional for demo mode
└── package.json      Workspace root + convenience scripts
```

### The deterministic core (`server/src/engine`)

| Module | Responsibility |
| --- | --- |
| `classifier.ts` | Maps raw gateway failure codes/reasons to a `FailureClass` with confidence. |
| `risk.ts` | Weighted, recency-decayed risk score (0–100) with band, confidence, evidence. |
| `patterns.ts` | Behavioural pattern detectors (cancellation cycling, value extraction, renewal avoidance). |
| `decision.ts` | `RECOVER / INTERVENE / RESTRICT / SUSPEND` rules + next-best recovery action. |
| `accessState.ts` | Access state machine `ACTIVE → RECOVERY → GRACE → RESTRICTED → SUSPENDED` (+ `BLACKLIST_RECOMMENDED` flag). |
| `revenue.ts` | Pure revenue-at-risk aggregation (recovered / at-risk / pending / lost, distribution). |
| `index.ts` | Pure `evaluateCustomer(...)` orchestrator returning a full explainable result. |

Every non-trivial output carries an `evidence[]` array of human-readable reasons,
so decisions are transparent and audit-ready. Each persisted decision, access
transition and merchant review action is written to an audit log.

## Getting started

Prerequisites: Node 22+ and npm 10+.

```bash
npm install                 # install all workspaces
cp .env.example .env        # optional; the app runs in demo mode without it
npm run seed                # populate the SQLite DB with the 7 demo scenarios
```

Then run the backend and the frontend in two terminals:

```bash
npm run dev:server          # backend on http://localhost:4000 (watch mode)
npm run dev:web             # frontend on http://localhost:5173 (Vite dev server)
```

Open the dashboard at **http://localhost:5173**. The Vite dev server proxies
`/api/*` to the backend on port 4000 (see `web/vite.config.ts`), so no CORS or
extra configuration is needed. If your backend runs on a different host/port,
set `VITE_API_TARGET` when starting the web dev server.

### Root scripts

| Script | What it does |
| --- | --- |
| `npm run build` | Builds **both** workspaces: server (`tsc`) then web (`tsc -b && vite build`). |
| `npm run build:server` / `npm run build:web` | Build a single workspace. |
| `npm run dev` / `npm run dev:server` | Run the backend in watch mode. |
| `npm run dev:web` | Run the Vite dev server for the frontend. |
| `npm run start` | Run the compiled backend (`server/dist`). |
| `npm run seed` | Seed the demo database. |
| `npm test` | Run the backend test suite (Vitest). |

## Environment variables

Copy `.env.example` to `.env`. **Every variable is optional**: with none set the
app runs fully in deterministic demo / simulation mode.

| Variable | Required? | Default | Purpose |
| --- | --- | --- | --- |
| `PORT` | No | `4000` | Backend HTTP port. |
| `DATABASE_PATH` | No | `data/app.db` | SQLite database file path. |
| `OPENROUTER_API_KEY` | No | _(unset)_ | Enables LLM-phrased explanation text. **Without it the app uses deterministic fallback text.** |
| `OPENROUTER_MODEL` | No | `openai/gpt-4o-mini` | Model id used when an OpenRouter key is set. Any OpenRouter model id works, including a free routing alias such as `openrouter/free`. |
| `OPENROUTER_BASE_URL` | No | `https://openrouter.ai/api/v1` | OpenRouter API base URL. |
| `RAZORPAY_MODE` | No | `simulation` | `simulation` (default) or `live`. |
| `RAZORPAY_KEY_ID` | No | _(unset)_ | Razorpay key id (only for `live`). |
| `RAZORPAY_KEY_SECRET` | No | _(unset)_ | Razorpay key secret (only for `live`). |
| `RAZORPAY_WEBHOOK_SECRET` | No | _(unset)_ | Secret used to verify webhook signatures in `live` mode. |
| `REVIEW_SECRET` | No | _(unset)_ | Optional shared secret guarding the mutating endpoints (`/review`, `/explain`). Unset = open demo; when set, those routes require `x-review-secret` or `Authorization: Bearer`. |

### Where to put the OpenRouter key

Put it in the **repo-root `.env`** file as `OPENROUTER_API_KEY=...`. That is the
single canonical local env file and the only place the key is read from. It is
loaded regardless of the workspace working directory: `server/src/config.ts`
resolves the `.env` path from the module's own location (two levels up), not
from `process.cwd()`, so it is found correctly even under `npm run dev:server`
(whose cwd is `server/`). A separate `server/.env` is **not** required and is
not used. `.env` is gitignored, so your key is never committed.

**Choosing a model.** The model is configurable via `OPENROUTER_MODEL` and
defaults to `openai/gpt-4o-mini`. Any OpenRouter model id is accepted, including
a free routing alias such as `openrouter/free`. On a successful call the app
reports the model that OpenRouter actually used for the completion (a routing
alias may resolve to a concrete model), so the reported model can differ from
the configured id.

**Source / model transparency.** If the key is absent or an API call fails, the
app transparently falls back to deterministic explanation text. The response
honestly reports the **true** `source` (`openrouter` only when a live completion
succeeded, otherwise `deterministic`), the actual `model`, and, on fallback, a
non-secret `fallbackReason` (for example `HTTP 401` or `empty completion`). The
API and the UI surface this provenance so it is always clear which text came
from the LLM and which came from the deterministic fallback. The decision itself
is unchanged either way, because the engine never depends on the LLM.

## Razorpay simulation mode & webhook verification

- The Razorpay adapter defaults to **simulation mode**: it synthesises plausible
  payment/subscription artefacts so the app is fully runnable without a live
  account. Set `RAZORPAY_MODE=live` to use real credentials.
- The webhook route `POST /api/webhooks/razorpay` verifies the signature by
  computing an **HMAC-SHA256** of the **exact raw request body** with
  `RAZORPAY_WEBHOOK_SECRET` and comparing it (constant-time) against the
  `X-Razorpay-Signature` header. The route is registered with a raw body parser
  so the bytes used for verification match what Razorpay signed.
- Webhook processing is **idempotent** (deduped on the event id) and recognises
  real Razorpay event names, e.g. `payment.captured`, `payment.failed`,
  `subscription.charged`, `subscription.halted`, `subscription.cancelled`.

## API overview

| Method & path | Purpose |
| --- | --- |
| `GET /api/health` | Liveness + active payment mode, LLM adapter kind, the configured model, and the AI mode. |
| `GET /api/dashboard` | Revenue summary, risk distribution, recent decisions/recoveries, predicted failures. |
| `GET /api/customers` | Customer list with score/band/decision/access state/blacklist flag. |
| `GET /api/customers/:id` | Subscription, payment history, behavioural timeline, risk, evidence, recommended action + expected outcome, access state. |
| `POST /api/customers/:id/explain` | LLM-or-fallback explanation + drafted recovery message, with the true `source`, `model`, and (on fallback) `fallbackReason`. |
| `POST /api/customers/:id/review` | Merchant controls: `approve_blacklist`, `reject_blacklist`, `reinstate_access`, `restore_access`. Writes the audit log. |
| `POST /api/webhooks/razorpay` | Ingests (signature-verified) payment events and re-evaluates. |

> **Guarding the mutating endpoints.** `/explain` and `/review` are the merchant
> trust boundary that keeps blacklist **human-approved** (the engine only ever
> *recommends* it). They are open by default so the zero-config demo works; set
> `REVIEW_SECRET` to require a matching `x-review-secret` header (or
> `Authorization: Bearer <secret>`) on those two routes. The comparison is
> constant-time and the guard is a no-op when the secret is unset.

> **Pattern over score.** The decision is deliberately **not** a pure function
> of the numeric risk band. A strong, unambiguous behavioural pattern (e.g.
> repeated cancel-before-renewal) can drive **RESTRICT** even while the numeric
> score sits in the *low* band — this is scenario 4 (Ishita Rao), which
> restricts at risk ≈ 31. The band summarises weighted, recency-decayed
> **payment/trust signals**; behavioural patterns are evaluated **alongside** it,
> so a low band next to a RESTRICT outcome is intended, not a contradiction. The
> risk score is a bounded 0–100 heuristic for banding, **not** a calibrated
> probability.

## Running the tests

```bash
npm test        # runs the backend Vitest suite (engine, adapters, revenue, API e2e)
```

The suite covers the classifier, risk scoring, pattern detectors, decision
rules, access-state machine, revenue aggregation, both adapters (including
webhook HMAC verification), and HTTP end-to-end tests via supertest.

## Known limitations

- **Simulation-mode payments.** Razorpay runs in simulation by default; no real
  charges, payment links or gateway calls happen unless configured for `live`.
- **LLM text is explanatory only.** Any OpenRouter output only phrases
  explanations / recovery messages. It never influences a decision, and a
  deterministic fallback is always used when no key is set or a call fails. When
  an OpenRouter call fails, the app degrades to deterministic text **visibly**:
  the response reports `source: "deterministic"` with a non-secret
  `fallbackReason`, and the UI shows the same, so the degradation is never
  hidden.
- **No machine learning.** Scoring and decisions are deterministic, hand-tuned,
  rules-based logic — not a trained model. "Predicted failures" is a simple
  heuristic over the latest decision and upcoming renewals.
- **Demo-scale data.** Ships with 7 hand-authored scenarios in a local SQLite
  file; it is not backed by a production datastore or real customer volume.
- **Not production-hardened.** No rate limiting, multi-tenancy or
  migrations-at-scale. The mutating endpoints (`/review`, `/explain`) support an
  **optional** shared-secret guard via `REVIEW_SECRET` (off by default for the
  demo); there is otherwise no full authentication / authorization or
  per-merchant identity. Intended as a demonstrable prototype.
