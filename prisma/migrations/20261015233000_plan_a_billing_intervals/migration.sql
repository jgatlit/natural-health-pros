-- Plan A billing, monthly and annual (vault task tsk_6abd668f59dc4e299ae1). Expand-only.

-- 1. Which interval a Plan A subscription was bought at. Nullable; written by the Layer X webhook.
ALTER TABLE "Practitioner" ADD COLUMN "subscriptionInterval" TEXT;

-- 2. The Whop plan each interval sells, read by loadPlanAPlanIds(). DO NOTHING on conflict so a
-- re-apply never overrides a plan id an operator has since changed.
INSERT INTO "PlatformSetting" ("key", "value", "createdAt", "updatedAt")
VALUES
  ('whop_plan_a_monthly_plan_id', 'plan_5YdWsNzoCg3Z3', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('whop_plan_a_annual_plan_id', 'plan_iAotyGNZkG6VW', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
