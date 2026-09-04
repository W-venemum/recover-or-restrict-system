import { api } from "../api/client";
import { Badge } from "../components/Badge";
import { useAsync } from "../lib/useAsync";
import { navigate } from "../lib/useHashRoute";
import {
  accessTone,
  bandTone,
  formatMoney,
  outcomeTone,
  titleize,
} from "../lib/format";

export function CustomerList() {
  const { data, loading, error, reload } = useAsync(() => api.getCustomers(), []);

  if (loading) return <div className="loading">Loading customers…</div>;
  if (error)
    return (
      <div className="error">
        <p>Could not load customers: {error}</p>
        <button className="btn" onClick={reload}>
          Retry
        </button>
      </div>
    );
  if (!data) return null;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Customers</h1>
        <button className="btn btn-ghost" onClick={reload}>
          Refresh
        </button>
      </div>
      <section className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Plan</th>
              <th className="num">Amount</th>
              <th>Decision</th>
              <th>Access state</th>
              <th>Risk</th>
              <th>Recommended action</th>
              <th>Blacklist</th>
            </tr>
          </thead>
          <tbody>
            {data.customers.map((c) => (
              <tr
                key={c.id}
                className="row-link"
                onClick={() => navigate(`/customers/${c.id}`)}
              >
                <td>
                  <div className="cust-name">{c.name}</div>
                  {c.email ? <div className="muted small">{c.email}</div> : null}
                </td>
                <td>{c.plan ?? "—"}</td>
                <td className="num">{formatMoney(c.amount, c.currency)}</td>
                <td>
                  {c.decision ? (
                    <Badge tone={outcomeTone(c.decision)}>{c.decision}</Badge>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  {c.accessState ? (
                    <Badge tone={accessTone(c.accessState)}>
                      {titleize(c.accessState)}
                    </Badge>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  {c.riskBand ? (
                    <Badge tone={bandTone(c.riskBand)}>
                      {c.riskScore !== null ? Math.round(c.riskScore) : "?"} · {c.riskBand}
                    </Badge>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>{c.recommendedAction ? titleize(c.recommendedAction) : "—"}</td>
                <td>
                  {c.blacklistRecommended ? (
                    <Badge tone="suspend">Recommended</Badge>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
