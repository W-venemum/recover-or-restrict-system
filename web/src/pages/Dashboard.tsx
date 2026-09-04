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
        <h1>Revenue &amp; trust overview</h1>
        <button className="btn btn-ghost" onClick={reload}>
          Refresh
        </button>
      </div>

      <section className="metric-grid">
        <Metric
          label="Total subscription revenue"
          value={formatMoney(r.totalSubscriptionRevenue, currency)}
        />
        <Metric
          label="Recovered revenue"
          value={formatMoney(r.recoveredRevenue, currency)}
          tone="recover"
        />
        <Metric
          label="Revenue at risk"
          value={formatMoney(r.revenueAtRisk, currency)}
          tone="intervene"
        />
        <Metric
          label="Pending recovery"
          value={formatMoney(r.pendingRecovery, currency)}
          tone="intervene"
        />
        <Metric
          label="Lost revenue"
          value={formatMoney(r.lostRevenue, currency)}
          tone="suspend"
        />
        <Metric
          label="Recovery rate"
          value={formatPercent(r.recoveryRate)}
          tone="recover"
          hint="recovered / (recovered + at risk + lost)"
        />
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
          <h2>Highest-priority customers</h2>
          {r.highestPriorityCustomers.length === 0 ? (
            <p className="muted">Nothing needs attention right now.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Outcome</th>
                  <th>Risk</th>
                  <th className="num">Amount</th>
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
                    <td>{Math.round(c.riskScore)}</td>
                    <td className="num">{formatMoney(c.amount, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <div className="two-col">
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
