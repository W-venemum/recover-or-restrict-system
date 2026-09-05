import { api } from "../api/client";
import { Badge } from "../components/Badge";
import { Bar } from "../components/Bar";
import { useAsync } from "../lib/useAsync";
import { navigate } from "../lib/useHashRoute";
import {
  accessTone,
  bandTone,
  formatDate,
  formatMoney,
  formatPercent,
  outcomeTone,
  titleize,
} from "../lib/format";

function Metric({
  label,
  value,
  tone = "neutral",
  hint,
}: {
  label: string;
  value: string;
  tone?: "recover" | "intervene" | "restrict" | "suspend" | "neutral";
  hint?: string;
}) {
  return (
    <div className={`metric metric-${tone}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {hint ? <div className="metric-hint">{hint}</div> : null}
    </div>
  );
}

/**
 * A compact "why is this customer prioritized" phrase derived purely from the
 * outcome and risk score already in the priority row. No fabricated data.
 */
function priorityWhy(outcome: string, riskScore: number): string {
  const score = Math.round(riskScore);
  switch (outcome) {
    case "SUSPEND":
      return `Revenue at risk of being lost · risk ${score}`;
    case "RESTRICT":
      return `Access restricted, still recoverable · risk ${score}`;
    case "INTERVENE":
      return `Failed payment needs intervention · risk ${score}`;
    default:
      return `Recovery in progress · risk ${score}`;
  }
}

function ModeStrip() {
  const { data } = useAsync(() => api.getHealth(), []);
  if (!data) return null;
  const paymentLabel = data.paymentMode === "live" ? "LIVE" : "SIMULATION";
  const aiLabel = data.aiMode === "openrouter" ? "OPENROUTER" : "DETERMINISTIC FALLBACK";
  const aiTone = data.aiMode === "openrouter" ? "recover" : "neutral";
  return (
    <div className="mode-strip" title="Actual runtime configuration">
      <span className="mode-item">
        <span className="mode-key">Payment mode</span>
        <Badge tone="intervene">{paymentLabel}</Badge>
      </span>
      <span className="mode-item">
        <span className="mode-key">AI mode</span>
        <Badge tone={aiTone}>{aiLabel}</Badge>
      </span>
      <span className="mode-item">
        <span className="mode-key">Model</span>
        <span className="mode-value">{data.model}</span>
      </span>
    </div>
  );
}

export function Dashboard() {
  const { data, loading, error, reload } = useAsync(() => api.getDashboard(), []);

  if (loading) return <div className="loading">Loading dashboard…</div>;
  if (error)
    return (
      <div className="error">
        <p>Could not load the dashboard: {error}</p>
        <p className="muted">
          Is the API running on port 4000? Start it with <code>npm run dev</code>{" "}
          and seed it with <code>npm run seed</code>.
        </p>
        <button className="btn" onClick={reload}>
          Retry
        </button>
      </div>
    );
  if (!data) return null;

  const r = data.revenue;
  const currency = r.currency;
  const dist = data.riskDistribution;
  const distMax = Math.max(dist.low, dist.medium, dist.high, 1);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>AI revenue recovery overview</h1>
          <p className="muted">
            How much revenue is recovered, at risk, pending or lost — and which
            customers need attention next.
          </p>
        </div>
        <button className="btn btn-ghost" onClick={reload}>
          Refresh
        </button>
      </div>

      <ModeStrip />

      {/* Primary recovery hierarchy: recovered, at risk, recovery rate, pending. */}
      <section className="metric-grid">
        <Metric
          label="Revenue recovered"
          value={formatMoney(r.recoveredRevenue, currency)}
          tone="recover"
          hint="Payments recovered back to active"
        />
        <Metric
          label="Revenue at risk"
          value={formatMoney(r.revenueAtRisk, currency)}
          tone="intervene"
          hint="Recoverable, awaiting intervention"
        />
        <Metric
          label="Recovery rate"
          value={formatPercent(r.recoveryRate)}
          tone="recover"
          hint="recovered / (recovered + at risk + lost)"
        />
        <Metric
          label="Pending recovery"
          value={formatMoney(r.pendingRecovery, currency)}
          tone="intervene"
          hint="Recovery action recommended, not yet resolved"
        />
      </section>

      {/* Secondary context: lost revenue and total book. */}
      <section className="metric-grid metric-grid-secondary">
        <Metric
          label="Lost revenue"
          value={formatMoney(r.lostRevenue, currency)}
          tone="suspend"
          hint="Leakage prevented via access restriction"
        />
        <Metric
          label="Total subscription revenue"
          value={formatMoney(r.totalSubscriptionRevenue, currency)}
          hint="Full recurring book under management"
        />
      </section>

      <section className="card">
        <h2>Highest-priority customers</h2>
        <p className="muted">
          Ranked by urgency (outcome, revenue at stake and risk). Click a row to
          review the decision and take the recommended recovery action.
        </p>
        {r.highestPriorityCustomers.length === 0 ? (
          <p className="muted">Nothing needs attention right now.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Outcome</th>
                <th>Recommended action</th>
                <th>Why prioritized</th>
                <th className="num">Revenue at stake</th>
              </tr>
            </thead>
            <tbody>
              {r.highestPriorityCustomers.map((c) => (
                <tr
                  key={c.subscriptionId}
                  className="row-link"
                  onClick={() => navigate(`/customers/${c.customerId}`)}
                >
                  <td>{c.customerId}</td>
                  <td>
                    <Badge tone={outcomeTone(c.outcome)}>{c.outcome}</Badge>
                  </td>
                  <td>
                    {c.recommendedAction ? (
                      titleize(c.recommendedAction)
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="muted small">
                    {priorityWhy(c.outcome, c.riskScore)}
                  </td>
                  <td className="num">{formatMoney(c.amount, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="two-col">
        <section className="card">
          <h2>Customer risk distribution</h2>
          <div className="dist">
            <div className="dist-row">
              <span className="dist-label">
                <Badge tone={bandTone("low")}>Low</Badge>
              </span>
              <Bar value={dist.low} max={distMax} tone="recover" />
              <span className="dist-count">{dist.low}</span>
            </div>
            <div className="dist-row">
              <span className="dist-label">
                <Badge tone={bandTone("medium")}>Medium</Badge>
              </span>
              <Bar value={dist.medium} max={distMax} tone="intervene" />
              <span className="dist-count">{dist.medium}</span>
            </div>
            <div className="dist-row">
              <span className="dist-label">
                <Badge tone={bandTone("high")}>High</Badge>
              </span>
              <Bar value={dist.high} max={distMax} tone="suspend" />
              <span className="dist-count">{dist.high}</span>
            </div>
          </div>
          <div className="account-counts">
            <div>
              <span className="count-value">{r.activeCount}</span>
              <span className="count-label">Active</span>
            </div>
            <div>
              <span className="count-value">{r.restrictedCount}</span>
              <span className="count-label">Restricted</span>
            </div>
            <div>
              <span className="count-value">{r.suspendedCount}</span>
              <span className="count-label">Suspended</span>
            </div>
          </div>
        </section>

        <section className="card">
          <h2>Recent recovery events</h2>
          {data.recentRecoveries.length === 0 ? (
            <p className="muted">No recovery events yet.</p>
          ) : (
            <ul className="event-list">
              {data.recentRecoveries.map((d, i) => (
                <li key={`${d.customerId}-${i}`}>
                  <Badge tone={outcomeTone(d.outcome)}>{d.outcome}</Badge>
                  <button
                    className="link"
                    onClick={() => navigate(`/customers/${d.customerId}`)}
                  >
                    {d.customerId}
                  </button>
                  <span className="muted">
                    → {titleize(d.nextAccessState)}
                  </span>
                  <span className="event-time">{formatDate(d.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h2>Predicted upcoming failures</h2>
          {r.predictedFailures.length === 0 ? (
            <p className="muted">No high-probability failures in the window.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Renewal</th>
                  <th>Risk</th>
                  <th className="num">Probability</th>
                </tr>
              </thead>
              <tbody>
                {r.predictedFailures.map((p) => (
                  <tr
                    key={p.subscriptionId}
                    className="row-link"
                    onClick={() => navigate(`/customers/${p.customerId}`)}
                  >
                    <td>{p.customerId}</td>
                    <td>{formatDate(p.nextRenewalAt)}</td>
                    <td>
                      <Badge tone={bandTone(p.riskBand)}>{p.riskBand}</Badge>
                    </td>
                    <td className="num">{formatPercent(p.probability)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section className="card">
        <h2>Recent decisions</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Outcome</th>
              <th>Access state</th>
              <th>Risk</th>
              <th>Blacklist</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {data.recentDecisions.map((d, i) => (
              <tr
                key={`${d.customerId}-${i}`}
                className="row-link"
                onClick={() => navigate(`/customers/${d.customerId}`)}
              >
                <td>{d.customerId}</td>
                <td>
                  <Badge tone={outcomeTone(d.outcome)}>{d.outcome}</Badge>
                </td>
                <td>
                  <Badge tone={accessTone(d.nextAccessState)}>
                    {titleize(d.nextAccessState)}
                  </Badge>
                </td>
                <td>{d.riskScore !== undefined ? Math.round(d.riskScore) : "—"}</td>
                <td>
                  {d.blacklistRecommended ? (
                    <Badge tone="suspend">Recommended</Badge>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="muted">{formatDate(d.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
