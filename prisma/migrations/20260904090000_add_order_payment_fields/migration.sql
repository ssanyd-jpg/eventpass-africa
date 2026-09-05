-- Real Airpay payment collection needs to record the aggregator's own
-- reference/message for reconciliation (mirrors WalletTransaction's
-- providerReference/providerMessage) plus which collection path the order
-- took (online STK push vs. offline optimistic-then-reconcile). All
-- nullable/additive — no backfill needed, every existing Order predates
-- this feature and is implicitly neither.
ALTER TABLE "Order" ADD COLUMN "providerReference" TEXT;
ALTER TABLE "Order" ADD COLUMN "providerMessage" TEXT;
ALTER TABLE "Order" ADD COLUMN "paymentMethod" TEXT;
