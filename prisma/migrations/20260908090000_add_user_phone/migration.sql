-- Real SMS notifications (Session 6) need a phone number to send to.
-- Nullable — no signup flow collects one; it's populated opportunistically
-- at AIRPAY_ONLINE checkout time (see handleSellTickets).
ALTER TABLE "User" ADD COLUMN "phone" TEXT;
