-- Session 22 performance audit: indexes for the three least-indexed hot
-- columns found via EXPLAIN ANALYZE + call-site review of the analytics,
-- live-monitoring, and vendor/sponsor dashboard queries. Purely additive —
-- no data change, no application behavior change.

-- Order.eventId / Order.status: every organizer analytics, live-monitoring,
-- and customer-list/detail fetcher filters orders by eventId (often with a
-- status IN (...) filter alongside it); Order.userId is filtered by the
-- sync pull route's myOrders query and getCustomerDetailData. Neither had
-- an index before this.
CREATE INDEX "Order_eventId_status_idx" ON "Order"("eventId", "status");
CREATE INDEX "Order_userId_idx" ON "Order"("userId");

-- Ticket.eventId: getLiveEventData, getOrganizerAnalyticsData, and
-- getPlatformAnalyticsData all filter tickets by eventId with zero index
-- to use — Ticket only had unique indexes on clientId/code before this.
CREATE INDEX "Ticket_eventId_idx" ON "Ticket"("eventId");

-- WalletTransaction.walletId: the only existing index touching this column
-- is the campaignId-first (campaignId, walletId) unique constraint, which
-- is useless for a plain walletId lookup since campaignId is null on
-- nearly every row. Every wallet's own transaction history, the vendor/
-- sponsor dashboards' today-only queries, the sync pull route's
-- myWalletTransactions, and the AirPay reconciliation report all join back
-- to Wallet through this column.
CREATE INDEX "WalletTransaction_walletId_createdAt_idx" ON "WalletTransaction"("walletId", "createdAt");
