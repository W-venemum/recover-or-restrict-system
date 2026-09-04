import { navigate, useHashRoute } from "./lib/useHashRoute";
import { Dashboard } from "./pages/Dashboard";
import { CustomerList } from "./pages/CustomerList";
import { CustomerDetail } from "./pages/CustomerDetail";

export function App() {
  const route = useHashRoute();

  let page = <Dashboard />;
  const detailMatch = route.match(/^\/customers\/(.+)$/);
  if (detailMatch) {
    page = <CustomerDetail id={decodeURIComponent(detailMatch[1])} />;
  } else if (route.startsWith("/customers")) {
    page = <CustomerList />;
  } else {
    page = <Dashboard />;
  }

  const isDashboard = !route.startsWith("/customers");
  const isCustomers = route.startsWith("/customers");

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">R/R</span>
          <div>
            <div className="brand-title">Recover-or-Restrict</div>
            <div className="brand-sub">Subscription revenue recovery &amp; trust engine</div>
          </div>
        </div>
        <nav className="nav">
          <button
            className={isDashboard ? "nav-link active" : "nav-link"}
            onClick={() => navigate("/")}
          >
            Dashboard
          </button>
          <button
            className={isCustomers ? "nav-link active" : "nav-link"}
            onClick={() => navigate("/customers")}
          >
            Customers
          </button>
        </nav>
      </header>
      <main className="content">{page}</main>
      <footer className="footer">
        Deterministic demo mode. Decisions are explainable and rules-based; any
        LLM text is explanatory only.
      </footer>
    </div>
  );
}
