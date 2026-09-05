/**
 * Thin fetch wrapper for the backend REST API.
 *
 * All calls use relative `/api/...` paths; the Vite dev server proxies them to
 * the backend (see vite.config.ts). In a production build the frontend is
 * served behind the same origin as the API.
 */

import type {
  CustomerDetailResponse,
  CustomerListResponse,
  DashboardResponse,
  ExplainResponse,
  HealthResponse,
  ReviewAction,
  ReviewResponse,
} from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      // ignore non-JSON error bodies
    }
    throw new Error(`${res.status}: ${detail}`);
  }
  return (await res.json()) as T;
}

export const api = {
  getHealth: () => request<HealthResponse>("/api/health"),
  getDashboard: () => request<DashboardResponse>("/api/dashboard"),
  getCustomers: () => request<CustomerListResponse>("/api/customers"),
  getCustomer: (id: string) =>
    request<CustomerDetailResponse>(`/api/customers/${encodeURIComponent(id)}`),
  explain: (id: string) =>
    request<ExplainResponse>(`/api/customers/${encodeURIComponent(id)}/explain`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  review: (id: string, action: ReviewAction, note?: string) =>
    request<ReviewResponse>(`/api/customers/${encodeURIComponent(id)}/review`, {
      method: "POST",
      body: JSON.stringify(note ? { action, note } : { action }),
    }),
};
