import { useState } from "react";
import { api } from "../api/client";
import { Badge } from "../components/Badge";
import { useAsync } from "../lib/useAsync";
import { navigate } from "../lib/useHashRoute";
import type { ExplainResponse, ReviewAction } from "../api/types";
import {
  accessTone,
  bandTone,
  formatDate,
  formatDateShort,
  formatMoney,
  outcomeTone,
  titleize,
} from "../lib/format";

function eventTone(type: string): "recover" | "suspend" | "intervene" | "neutral" {
  if (type.includes("succeeded")) return "recover";
  if (type.includes("failed") || type.includes("chargeback")) return "suspend";
  if (type.includes("cancel") || type.includes("grace")) return "intervene";
  return "neutral";
}

export function CustomerDetail({ id }: { id: string }) {
  const { data, loading, error, reload } = useAsync(() => api.getCustomer(id), [id]);
  const [explain, setExplain] = useState<ExplainResponse | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [explainError, setExplainError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<ReviewAction | null>(null);
  const [reviewMsg, setReviewMsg] = useState<string | null>(null);
  const [note, setNote] = useState("");

  if (loading) return <div className="loading">Loading customer…</div>;
  if (error)
    return (
      <div className="error">
        <p>Could not load customer: {error}</p>
        <button className="btn" onClick={() => navigate("/customers")}>
          Back to customers
        </button>
      </div>
    );
  if (!data) return null;

  const currency = data.subscription?.currency ?? "INR";

  async function runExplain() {
    setExplaining(true);
    setExplainError(null);
    try {
      setExplain(await api.explain(id));
    } catch (err) {
      setExplainError(err instanceof Error ? err.message : String(err));
    } finally {
      setExplaining(false);
    }
  }

  async function runReview(action: ReviewAction) {
    setReviewing(action);
    setReviewMsg(null);
    try {
      const res = await api.review(id, action, note.trim() || undefined);
      setReviewMsg(
        `Access state ${titleize(res.fromState)} → ${titleize(res.accessState)}.`,
      );
      setNote("");
      reload();
    } catch (err) {
      setReviewMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setReviewing(null);
    }
  }

  const blacklist = data.blacklistRecommended;

  // Pattern-over-band: a strong behavioural pattern can drive RESTRICT/SUSPEND
  // even when the numeric risk band is low/medium. Surface a short note so a
  // low band next to a restrictive outcome reads as intended, not a bug.
  const restrictive = data.decision === "RESTRICT" || data.decision === "SUSPEND";
  const patternOverBand =
    restrictive && (data.riskBand === "low" || data.riskBand === "medium");

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <button className="link" onClick={() => navigate("/customers")}>
            ← Customers
          </button>
          <h1>{data.customer.name}</h1>
          {data.customer.email ? (
            <div className="muted">{data.customer.email}</div>
          ) : null}
        </div>
        <button className="btn btn-ghost" onClick={reload}>
          Refresh
        </button>
      </div>

      {/* Decision summary banner: makes RECOVER vs RESTRICT/SUSPEND obvious. */}
      <section className={`banner banner-${outcomeTone(data.decision)}`}>
        <div className="banner-main">
          <span className="banner-label">Decision</span>
          <span className="banner-outcome">{data.decision ?? "—"}</span>
          {blacklist ? (
            <Badge tone="suspend" title="Recommendation only; never auto-applied">
              Blacklist recommended (human review)
            </Badge>
          ) : (
            <Badge tone="recover">Not blacklisted</Badge>
          )}
        </div>
        <div className="banner-side">
          <div>
            <span className="mini-label">Access state</span>
            <Badge tone={accessTone(data.accessState)}>
              {titleize(data.accessState)}
            </Badge>
          </div>
          <div>
            <span className="mini-label">Trust / risk score</span>
            {data.riskScore !== null ? (
              <Badge tone={bandTone(data.riskBand)}>
                {Math.round(data.riskScore)} / 100 · {data.riskBand}
              </Badge>
            ) : (
              <span className="muted">—</span>
            )}
          </div>
        </div>
      </section>

      {patternOverBand ? (
        <p className="note">
          <strong>Pattern over score:</strong> a strong behavioural pattern (see
          the evidence below) drove this <strong>{data.decision}</strong> outcome
          independently of the numeric risk band, which is{" "}
          <strong>{data.riskBand}</strong>. The score summarises weighted,
          recency-decayed payment/trust signals and is a bounded 0–100 heuristic
          for banding, not a calibrated probability; behavioural patterns are
          evaluated alongside it, so a low band next to a restrictive decision is
          intended.
        </p>
      ) : null}

      <div className="two-col">
        <section className="card">
          <h2>Subscription</h2>
          {data.subscription ? (
            <dl className="kv">
              <dt>Plan</dt>
              <dd>{data.subscription.plan}</dd>
              <dt>Amount</dt>
              <dd>{formatMoney(data.subscription.amount, currency)}</dd>
              <dt>Started</dt>
              <dd>{formatDateShort(data.subscription.startedAt)}</dd>
              <dt>Next renewal</dt>
              <dd>{formatDateShort(data.subscription.nextRenewalAt)}</dd>
              <dt>Access state</dt>
              <dd>
                <Badge tone={accessTone(data.subscription.accessState)}>
                  {titleize(data.subscription.accessState)}
                </Badge>
              </dd>
            </dl>
          ) : (
            <p className="muted">No subscription on file.</p>
          )}
        </section>

        <section className="card">
          <h2>Recommended recovery action</h2>
          {data.recommendedAction ? (
            <>
              <p className="action-name">{titleize(data.recommendedAction)}</p>
              {data.expectedRecoveryOutcome ? (
                <p className="muted">{data.expectedRecoveryOutcome}</p>
              ) : null}
            </>
          ) : (
            <p className="muted">
              No recovery action recommended for the current decision.
            </p>
          )}
        </section>
      </div>

      <section className="card">
        <h2>Why this decision — evidence</h2>
        {data.evidence.length === 0 ? (
          <p className="muted">No evidence recorded.</p>
        ) : (
          <ul className="evidence-list">
            {data.evidence.map((e, i) => (
              <li key={`${e.code}-${i}`}>
                <div className="evidence-msg">{e.message}</div>
                <div className="evidence-meta">
                  <code>{e.code}</code>
                  {typeof e.weight === "number" ? (
                    <span
                      className={e.weight >= 0 ? "weight-up" : "weight-down"}
                      title="Signed contribution to the risk score"
                    >
                      {e.weight >= 0 ? "+" : ""}
                      {e.weight}
                    </span>
                  ) : null}
                  {typeof e.confidence === "number" ? (
                    <span className="muted">
                      conf {Math.round(e.confidence * 100)}%
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="two-col">
        <section className="card">
          <h2>Payment history</h2>
          {data.paymentHistory.length === 0 ? (
            <p className="muted">No payment events.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th className="num">Amount</th>
                  <th>Failure</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {data.paymentHistory.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Badge tone={eventTone(p.type)}>{titleize(p.type)}</Badge>
                    </td>
                    <td className="num">{formatMoney(p.amount, currency)}</td>
                    <td>
                      {p.failureCode ? (
                        <span title={p.failureReason}>{p.failureCode}</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="muted">{formatDateShort(p.timestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="card">
          <h2>Behavioural timeline</h2>
          {data.timeline.length === 0 ? (
            <p className="muted">No events recorded.</p>
          ) : (
            <ul className="timeline">
              {data.timeline.map((t, i) => (
                <li key={i} className={`timeline-item tl-${eventTone(t.type)}`}>
                  <span className="tl-dot" />
                  <div className="tl-body">
                    <div className="tl-title">
                      {titleize(t.type)}
                      {t.kind === "payment" && t.amount !== undefined ? (
                        <span className="muted"> · {formatMoney(t.amount, currency)}</span>
                      ) : null}
                    </div>
                    {t.failureCode ? (
                      <div className="muted small">{t.failureCode}</div>
                    ) : null}
                    {t.metadata?.duringUnpaidPeriod ? (
                      <div className="small">
                        <Badge tone="suspend">during unpaid period</Badge>
                        {t.metadata.feature ? ` · ${t.metadata.feature}` : ""}
                      </div>
                    ) : null}
                    {t.metadata?.daysToRenewal !== undefined ? (
                      <div className="muted small">
                        {t.metadata.daysToRenewal} day(s) to renewal
                      </div>
                    ) : null}
                    <div className="muted small">{formatDate(t.timestamp)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="card">
        <h2>Explain &amp; drafted recovery message</h2>
        <p className="muted">
          Generates a human-readable narrative from the decision evidence. Uses
          OpenRouter when a key is configured, otherwise a deterministic
          fallback. This text is explanatory only and never changes the
          decision.
        </p>
        <button className="btn" onClick={runExplain} disabled={explaining}>
          {explaining ? "Generating…" : "Explain this decision"}
        </button>
        {explainError ? <p className="error-inline">{explainError}</p> : null}
        {explain ? (
          <div className="explain">
            <div className="explain-badge">
              <Badge tone="neutral">source: {explain.source}</Badge>
            </div>
            <h3>Explanation</h3>
            <p className="explain-text">{explain.explanation}</p>
            <h3>Drafted recovery message</h3>
            <p className="explain-text draft">{explain.recoveryMessage}</p>
          </div>
        ) : null}
      </section>

      <section className="card">
        <h2>Merchant review &amp; appeal controls</h2>
        <p className="muted">
          Blacklisting is only ever a recommendation. Approving it moves the
          account to a human-reviewed state; it is never applied automatically.
        </p>
        <label className="field">
          <span>Note (optional, recorded in the audit log)</span>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Customer confirmed card was updated"
          />
        </label>
        <div className="review-actions">
          <button
            className="btn btn-danger"
            disabled={reviewing !== null}
            onClick={() => runReview("approve_blacklist")}
          >
            {reviewing === "approve_blacklist" ? "…" : "Approve blacklist"}
          </button>
          <button
            className="btn btn-warn"
            disabled={reviewing !== null}
            onClick={() => runReview("reject_blacklist")}
          >
            {reviewing === "reject_blacklist" ? "…" : "Reject blacklist (keep restricted)"}
          </button>
          <button
            className="btn"
            disabled={reviewing !== null}
            onClick={() => runReview("reinstate_access")}
          >
            {reviewing === "reinstate_access" ? "…" : "Reinstate to grace"}
          </button>
          <button
            className="btn btn-success"
            disabled={reviewing !== null}
            onClick={() => runReview("restore_access")}
          >
            {reviewing === "restore_access" ? "…" : "Restore access (active)"}
          </button>
        </div>
        {reviewMsg ? <p className="review-msg">{reviewMsg}</p> : null}
      </section>
    </div>
  );
}
