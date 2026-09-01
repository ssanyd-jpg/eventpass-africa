// Pure, DB-free deterministic anomaly detection — NOT Claude-backed, same
// "hand-rolled analytics" reasoning as forecast.ts. Every rule here is a
// small, auditable threshold check over rows the caller already has
// (client-side from Dexie, or a small admin-only Prisma fetcher) — no
// training, no model, nothing non-deterministic.

export interface AnomalyFlag {
  severity: "LOW" | "MEDIUM" | "HIGH";
  code: string;
  message: string;
  relatedId: string;
}

// ---------- Orders ----------

export interface OrderAnomalyRow {
  id: string;
  userId: string;
  userCreatedAt?: string;
  status: string;
  discountCode?: string | null;
  createdAt: string;
  ticketCount: number;
}

const DISCOUNT_VELOCITY_THRESHOLD = 5;
const DISCOUNT_VELOCITY_WINDOW_MS = 10 * 60 * 1000;
const REFUND_RATE_MIN_ORDERS = 3;
const REFUND_RATE_THRESHOLD = 0.5;
const NEW_ACCOUNT_MIN_TICKETS = 10;
const NEW_ACCOUNT_WINDOW_MS = 60 * 60 * 1000;

export function detectOrderAnomalies(orders: OrderAnomalyRow[]): AnomalyFlag[] {
  const flags: AnomalyFlag[] = [];

  // Rule 1: ≥5 redemptions of the same discount code within a 10-minute
  // window — flags every order in the burst.
  const byCode = new Map<string, OrderAnomalyRow[]>();
  for (const o of orders) {
    if (!o.discountCode) continue;
    const group = byCode.get(o.discountCode) ?? [];
    group.push(o);
    byCode.set(o.discountCode, group);
  }
  for (const group of Array.from(byCode.values())) {
    const sorted = [...group].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    for (const o of sorted) {
      const t = new Date(o.createdAt).getTime();
      const withinWindow = sorted.filter((other) => {
        const dt = new Date(other.createdAt).getTime();
        return dt <= t && t - dt <= DISCOUNT_VELOCITY_WINDOW_MS;
      });
      if (withinWindow.length >= DISCOUNT_VELOCITY_THRESHOLD) {
        flags.push({
          severity: "HIGH",
          code: "DISCOUNT_VELOCITY",
          message: `${withinWindow.length} redemptions of code "${o.discountCode}" within 10 minutes.`,
          relatedId: o.id,
        });
      }
    }
  }

  // Rule 2: a buyer with ≥3 orders where more than half are REFUNDED —
  // flags every order from that buyer (not just the refunded ones), so
  // whichever order row is on screen shows the signal.
  const byBuyer = new Map<string, OrderAnomalyRow[]>();
  for (const o of orders) {
    const group = byBuyer.get(o.userId) ?? [];
    group.push(o);
    byBuyer.set(o.userId, group);
  }
  for (const group of Array.from(byBuyer.values())) {
    if (group.length < REFUND_RATE_MIN_ORDERS) continue;
    const refundedCount = group.filter((o) => o.status === "REFUNDED").length;
    const rate = refundedCount / group.length;
    if (rate > REFUND_RATE_THRESHOLD) {
      for (const o of group) {
        flags.push({
          severity: "MEDIUM",
          code: "REFUND_RATE",
          message: `${refundedCount} of ${group.length} orders from this buyer were refunded.`,
          relatedId: o.id,
        });
      }
    }
  }

  // Rule 3: a single large order (≥10 tickets) from an account created
  // within the last hour before the order — a classic scalping/bot signal.
  for (const o of orders) {
    if (o.ticketCount < NEW_ACCOUNT_MIN_TICKETS || !o.userCreatedAt) continue;
    const accountAgeMs = new Date(o.createdAt).getTime() - new Date(o.userCreatedAt).getTime();
    if (accountAgeMs >= 0 && accountAgeMs <= NEW_ACCOUNT_WINDOW_MS) {
      flags.push({
        severity: "HIGH",
        code: "NEW_ACCOUNT_LARGE_ORDER",
        message: `${o.ticketCount} tickets bought by an account created under an hour earlier.`,
        relatedId: o.id,
      });
    }
  }

  return flags;
}

// ---------- Vendor applications ----------

export interface VendorAnomalyRow {
  id: string;
  contactEmail: string;
  contactPhone: string;
  ownerUserId: string | null;
  createdAt: string;
}

const APPLICATION_VELOCITY_THRESHOLD = 4;
const APPLICATION_VELOCITY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function detectVendorAnomalies(vendors: VendorAnomalyRow[]): AnomalyFlag[] {
  const flags: AnomalyFlag[] = [];

  // Rule 4: ≥2 applications (any events, same org) sharing a non-empty
  // contact email or phone.
  const byEmail = new Map<string, VendorAnomalyRow[]>();
  const byPhone = new Map<string, VendorAnomalyRow[]>();
  for (const v of vendors) {
    if (v.contactEmail) byEmail.set(v.contactEmail, [...(byEmail.get(v.contactEmail) ?? []), v]);
    if (v.contactPhone) byPhone.set(v.contactPhone, [...(byPhone.get(v.contactPhone) ?? []), v]);
  }
  const flaggedForDuplication = new Set<string>();
  for (const group of Array.from(byEmail.values()).concat(Array.from(byPhone.values()))) {
    if (group.length < 2) continue;
    for (const v of group) {
      if (flaggedForDuplication.has(v.id)) continue;
      flaggedForDuplication.add(v.id);
      flags.push({
        severity: "MEDIUM",
        code: "CONTACT_DUPLICATE",
        message: "Shares contact info with another application.",
        relatedId: v.id,
      });
    }
  }

  // Rule 5: >4 applications from the same owner (or same contact email for
  // an unauthenticated applicant) within 24 hours.
  const byApplicant = new Map<string, VendorAnomalyRow[]>();
  for (const v of vendors) {
    const key = v.ownerUserId ?? (v.contactEmail ? `email:${v.contactEmail}` : null);
    if (!key) continue;
    byApplicant.set(key, [...(byApplicant.get(key) ?? []), v]);
  }
  for (const group of Array.from(byApplicant.values())) {
    const sorted = [...group].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    for (const v of sorted) {
      const t = new Date(v.createdAt).getTime();
      const withinWindow = sorted.filter((other) => {
        const dt = new Date(other.createdAt).getTime();
        return dt <= t && t - dt <= APPLICATION_VELOCITY_WINDOW_MS;
      });
      if (withinWindow.length > APPLICATION_VELOCITY_THRESHOLD) {
        flags.push({
          severity: "MEDIUM",
          code: "APPLICATION_VELOCITY",
          message: `${withinWindow.length} vendor applications from the same applicant within 24 hours.`,
          relatedId: v.id,
        });
      }
    }
  }

  return flags;
}

// ---------- SponsorCampaign redemptions ----------

export interface CampaignRedemptionRow {
  id: string; // WalletTransaction id
  campaignId: string;
  walletId: string;
  createdAt: string;
}

const CAMPAIGN_BURST_THRESHOLD = 5;
const CAMPAIGN_BURST_WINDOW_MS = 10 * 60 * 1000;

// Distinct-wallet redemption burst on a single campaign — the existing
// @@unique([campaignId, walletId]) constraint already stops one wallet
// redeeming twice; this catches coordinated abuse across many wallets that
// constraint can't see.
export function detectCampaignRedemptionAnomalies(redemptions: CampaignRedemptionRow[]): AnomalyFlag[] {
  const flags: AnomalyFlag[] = [];
  const byCampaign = new Map<string, CampaignRedemptionRow[]>();
  for (const r of redemptions) {
    const group = byCampaign.get(r.campaignId) ?? [];
    group.push(r);
    byCampaign.set(r.campaignId, group);
  }
  for (const group of Array.from(byCampaign.values())) {
    const sorted = [...group].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    for (const r of sorted) {
      const t = new Date(r.createdAt).getTime();
      const withinWindow = sorted.filter((other) => {
        const dt = new Date(other.createdAt).getTime();
        return dt <= t && t - dt <= CAMPAIGN_BURST_WINDOW_MS;
      });
      const distinctWallets = new Set(withinWindow.map((w) => w.walletId)).size;
      if (distinctWallets >= CAMPAIGN_BURST_THRESHOLD) {
        flags.push({
          severity: "MEDIUM",
          code: "CAMPAIGN_REDEMPTION_BURST",
          message: `${distinctWallets} different wallets redeemed this campaign within 10 minutes.`,
          relatedId: r.id,
        });
      }
    }
  }
  return flags;
}
