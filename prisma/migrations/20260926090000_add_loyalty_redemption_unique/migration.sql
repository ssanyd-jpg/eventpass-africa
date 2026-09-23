-- Session 33 — one redemption per attendee per reward, enforced as a real
-- constraint (not just an application check) so two concurrent redeem
-- attempts can't both win. Purely additive.

CREATE UNIQUE INDEX "LoyaltyRedemption_rewardId_userId_key" ON "LoyaltyRedemption"("rewardId", "userId");
