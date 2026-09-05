/**
 * Frontend mirror of the backend response shapes.
 *
 * These are intentionally hand-written (not shared with the server package) so
 * the web workspace stays independently buildable. Field names match the JSON
 * returned by server/src/api/app.ts exactly.
 */

export type DecisionOutcome = "RECOVER" | "INTERVENE" | "RESTRICT" | "SUSPEND";

export type AccessState =
  | "ACTIVE"
  | "RECOVERY"
  | "GRACE"
  | "RESTRICTED"
  | "SUSPENDED"
  | "BLACKLIST_RECOMMENDED";

export type RiskBand = "low" | "medium" | "high";

export type RecoveryAction =
  | "retry"
  | "delayed_retry"
  | "payment_reminder"
  | "alternate_payment_method"
  | "upi_payment_link"
  | "update_payment_method"
  | "limited_grace_period";

export interface Evidence {
  code: string;
  message: string;
  weight?: number;
  confidence?: number;
}

export interface RevenueSummary {
  currency: string;
  totalSubscriptionRevenue: number;
  recoveredRevenue: number;
  revenueAtRisk: number;
  pendingRecovery: number;
  lostRevenue: number;
  recoveryRate: number;
  riskDistribution: Record<RiskBand, number>;
  restrictedCount: number;
  suspendedCount: number;
  activeCount: number;
  highestPriorityCustomers: HighPriorityCustomer[];
  predictedFailures: PredictedFailure[];
}

export interface HighPriorityCustomer {
  customerId: string;
  subscriptionId: string;
  amount: number;
  outcome: DecisionOutcome;
  riskScore: number;
  priority: number;
  /** Recommended recovery intervention (pass-through of the stored decision). */
  recommendedAction?: RecoveryAction;
}

export interface PredictedFailure {
  customerId: string;
  subscriptionId: string;
  nextRenewalAt: string;
  amount: number;
  probability: number;
  riskBand: RiskBand;
}

export interface RecentDecision {
  customerId: string;
  outcome: DecisionOutcome;
  nextAccessState: AccessState;
  riskScore?: number;
  riskBand?: RiskBand;
  recommendedAction?: RecoveryAction;
  blacklistRecommended: boolean;
  createdAt: string;
}

export interface DashboardResponse {
  revenue: RevenueSummary;
  riskDistribution: Record<RiskBand, number>;
  recentDecisions: RecentDecision[];
  recentRecoveries: RecentDecision[];
}

export interface CustomerListItem {
  id: string;
  name: string;
  email?: string;
  plan?: string;
  amount?: number;
  currency?: string;
  accessState?: AccessState;
  riskScore: number | null;
  riskBand: RiskBand | null;
  decision: DecisionOutcome | null;
  recommendedAction: RecoveryAction | null;
  blacklistRecommended: boolean;
}

export interface CustomerListResponse {
  customers: CustomerListItem[];
}

export interface Customer {
  id: string;
  name: string;
  email?: string;
  createdAt: string;
}

export interface Subscription {
  id: string;
  customerId: string;
  plan: string;
  amount: number;
  currency: string;
  startedAt: string;
  nextRenewalAt?: string;
  accessState: AccessState;
}

export interface PaymentEvent {
  id: string;
  customerId: string;
  subscriptionId: string;
  type: string;
  timestamp: string;
  amount?: number;
  currency?: string;
  failureCode?: string;
  failureReason?: string;
  attempt?: number;
}

export interface BehaviouralEvent {
  id: string;
  customerId: string;
  subscriptionId?: string;
  type: string;
  timestamp: string;
  metadata?: {
    daysToRenewal?: number;
    duringUnpaidPeriod?: boolean;
    feature?: string;
  };
}

export interface TimelineEntry {
  kind: "payment" | "behavioural";
  type: string;
  timestamp: string;
  amount?: number;
  failureCode?: string;
  failureReason?: string;
  metadata?: BehaviouralEvent["metadata"];
}

export interface CustomerDetailResponse {
  customer: Customer;
  subscription?: Subscription;
  subscriptions: Subscription[];
  paymentHistory: PaymentEvent[];
  behaviouralTimeline: BehaviouralEvent[];
  timeline: TimelineEntry[];
  riskScore: number | null;
  riskBand: RiskBand | null;
  decision: DecisionOutcome | null;
  recommendedAction: RecoveryAction | null;
  expectedRecoveryOutcome: string | null;
  blacklistRecommended: boolean;
  accessState: AccessState | null;
  evidence: Evidence[];
}

export interface ExplainResponse {
  source: "openrouter" | "deterministic";
  model: string;
  outcome: DecisionOutcome;
  explanation: string;
  recoveryMessage: string;
  /** Present only when an intended OpenRouter call degraded to the fallback. */
  fallbackReason?: string;
}

export interface HealthResponse {
  status: string;
  paymentMode: "simulation" | "live";
  llm: "openrouter" | "deterministic";
  /** Configured model id, or "deterministic" for the pure fallback adapter. */
  model: string;
  aiMode: "openrouter" | "deterministic";
}

export type ReviewAction =
  | "approve_blacklist"
  | "reject_blacklist"
  | "reinstate_access"
  | "restore_access";

export interface ReviewResponse {
  status: string;
  action: ReviewAction;
  fromState: AccessState;
  accessState: AccessState;
}
