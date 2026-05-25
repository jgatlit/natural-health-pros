-- Revert: Wedge 2C requires Whop for Platforms (Connected Accounts) for proper multi-tenant
-- payment routing. Practitioner-owned paymentUrl was wrong direction per operator decision
-- 2026-05-25. Re-architected as a centralized Whop platform integration pending Whop
-- Platforms API access (operator-side action: email sales@whop.com).

ALTER TABLE "Practitioner" DROP COLUMN IF EXISTS "paymentUrl";
