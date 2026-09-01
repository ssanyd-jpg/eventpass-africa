// Pure, DB-free deterministic risk scoring — NOT Claude-backed, reuses the
// same signal-extraction reasoning as anomaly.ts (both derive from the
// same underlying checks; anomaly detection thresholds them into boolean
// flags, risk scoring sums them into a continuous 0-100 score). See
// anomaly.ts's header comment for why this is deterministic, not LLM-based.

export type RiskBand = "LOW" | "MEDIUM" | "HIGH";

export interface RiskScore {
  score: number; // 0-100
  band: RiskBand;
  reasons: string[];
}

export function bandFromScore(score: number): RiskBand {
  if (score >= 70) return "HIGH";
  if (score >= 30) return "MEDIUM";
  return "LOW";
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// ---------- Orders ----------

export interface OrderRiskRow {
  id: string;
  userId: string;
  userCreatedAt?: string;
  status: string;
  discountCode?: string | null;
  createdAt: string;
  ticketCount: number;
  eventId: string;
}

const DISCOUNT_VELOCITY_WINDOW_MS = 10 * 60 * 1000;
const NEW_ACCOUNT_WINDOW_MS = 24 * 60 * 60 * 1000; // full scoring window; scales to 0 by 24h old

// context.allOrders should be every order in the same organization (or at
// minimum, every order sharing this order's discountCode/userId/eventId)
// — the caller decides the scope, same as customerStatsByBuyer's callers
// decide theirs.
export function scoreOrderRisk(order: OrderRiskRow, context: { allOrders: OrderRiskRow[] }): RiskScore {
  const reasons: string[] = [];
  let score = 0;

  // discountVelocity (0-30): how many redemptions of the same code landed
  // in the trailing 10 minutes ending at this order (including itself).
  if (order.discountCode) {
    const t = new Date(order.createdAt).getTime();
    const sameCode = context.allOrders.filter((o) => o.discountCode === order.discountCode);
    const withinWindow = sameCode.filter((o) => {
      const dt = new Date(o.createdAt).getTime();
      return dt <= t && t - dt <= DISCOUNT_VELOCITY_WINDOW_MS;
    });
    const discountVelocity = clamp((withinWindow.length - 1) * 6, 0, 30);
    if (discountVelocity > 0) {
      score += discountVelocity;
      reasons.push(`${withinWindow.length} redemptions of the same code within 10 minutes`);
    }
  }

  // refundRate (0-30): this buyer's lifetime refund rate across every
  // order the caller passed in.
  const buyerOrders = context.allOrders.filter((o) => o.userId === order.userId);
  if (buyerOrders.length >= 2) {
    const refundedCount = buyerOrders.filter((o) => o.status === "REFUNDED").length;
    const rate = refundedCount / buyerOrders.length;
    const refundRateScore = clamp(rate * 30, 0, 30);
    if (refundRateScore > 0) {
      score += refundRateScore;
      reasons.push(`${refundedCount} of ${buyerOrders.length} orders from this buyer refunded`);
    }
  }

  // accountAge (0-25): a large order from a very new account. 25 at <1h,
  // scaling to 0 by 24h old; also requires >=5 tickets — a brand-new
  // account buying 1 ticket is completely normal.
  if (order.userCreatedAt && order.ticketCount >= 5) {
    const accountAgeMs = new Date(order.createdAt).getTime() - new Date(order.userCreatedAt).getTime();
    if (accountAgeMs >= 0 && accountAgeMs < NEW_ACCOUNT_WINDOW_MS) {
      const accountAgeScore = clamp(25 * (1 - accountAgeMs / NEW_ACCOUNT_WINDOW_MS), 0, 25);
      if (accountAgeScore > 0) {
        score += accountAgeScore;
        reasons.push(`Account created ${Math.round(accountAgeMs / (60 * 1000))} min before this order`);
      }
    }
  }

  // firstOrderSize (0-15): this buyer's first-ever order is unusually
  // large relative to the median order size for this event.
  if (buyerOrders.length === 1 && buyerOrders[0].id === order.id) {
    const sameEventOrders = context.allOrders.filter((o) => o.eventId === order.eventId);
    const sizes = sameEventOrders.map((o) => o.ticketCount).sort((a, b) => a - b);
    const median = sizes.length > 0 ? sizes[Math.floor(sizes.length / 2)] : 0;
    if (median > 0 && order.ticketCount > median * 2) {
      const ratio = order.ticketCount / median;
      const firstOrderScore = clamp((ratio - 2) * 7.5, 0, 15);
      if (firstOrderScore > 0) {
        score += firstOrderScore;
        reasons.push(`First order is ${ratio.toFixed(1)}x the median order size for this event`);
      }
    }
  }

  const total = clamp(Math.round(score), 0, 100);
  return { score: total, band: bandFromScore(total), reasons };
}

// ---------- Vendor applications ----------

export interface VendorRiskRow {
  id: string;
  contactEmail: string;
  contactPhone: string;
  description: string;
  ownerUserId: string | null;
  createdAt: string;
}

const APPLICATION_VELOCITY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function scoreVendorRisk(vendor: VendorRiskRow, context: { allVendors: VendorRiskRow[] }): RiskScore {
  const reasons: string[] = [];
  let score = 0;

  // contactDuplication (0-40): shares contact info with another
  // application.
  const duplicates = context.allVendors.filter(
    (v) =>
      v.id !== vendor.id &&
      ((vendor.contactEmail && v.contactEmail === vendor.contactEmail) ||
        (vendor.contactPhone && v.contactPhone === vendor.contactPhone))
  );
  if (duplicates.length > 0) {
    score += 40;
    reasons.push(`Shares contact info with ${duplicates.length} other application(s)`);
  }

  // applicationVelocity (0-35): many applications from the same
  // owner/email within 24 hours.
  const key = vendor.ownerUserId ?? (vendor.contactEmail || null);
  if (key) {
    const sameApplicant = context.allVendors.filter((v) => (v.ownerUserId ?? (v.contactEmail || null)) === key);
    const t = new Date(vendor.createdAt).getTime();
    const withinWindow = sameApplicant.filter((v) => {
      const dt = new Date(v.createdAt).getTime();
      return dt <= t && t - dt <= APPLICATION_VELOCITY_WINDOW_MS;
    });
    const velocityScore = clamp((withinWindow.length - 1) * 9, 0, 35);
    if (velocityScore > 0) {
      score += velocityScore;
      reasons.push(`${withinWindow.length} applications from the same applicant within 24 hours`);
    }
  }

  // emptyProfile (0-25): blank description AND blank phone — a
  // low-effort/likely-spam application.
  if (!vendor.description.trim() && !vendor.contactPhone.trim()) {
    score += 25;
    reasons.push("No description or phone number provided");
  }

  const total = clamp(Math.round(score), 0, 100);
  return { score: total, band: bandFromScore(total), reasons };
}
