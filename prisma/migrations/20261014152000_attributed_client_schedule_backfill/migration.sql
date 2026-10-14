-- Pin every EXISTING attributed client to its practitioner's rate schedule (spec v1.5 s2 / s7:
-- "a schedule change leaves an in-term client's fee unchanged").
--
-- WHY THIS IS A SEPARATE MIGRATION: 20261014150000_rate_schedules_fee_rule_v15 added the nullable
-- "AttributedClient"."rateScheduleId" column and backfilled "Practitioner" only. A client row that
-- existed at deploy therefore had a NULL snapshot, and the fee path falls back to the practitioner's
-- CURRENT schedule for such a row - so the first cohort migration (v1 -> v2) would silently re-price
-- every pre-v1.5 client still inside the 8-month term. Pinning them to the schedule their practitioner
-- is on today closes that. (That migration was already applied by a preview, so it is not edited.)
--
-- Idempotent and expand-only: it only fills NULLs, never overwrites a snapshot, and a practitioner
-- with no schedule leaves their clients NULL (nothing to pin to; checkout refuses that practitioner
-- anyway). Re-applying changes nothing.
--
-- The two other v1.5 snapshot columns, "referrerTermMonths" / "referrerTermEndsAt", are left NULL on
-- purpose: the fee path already falls back field by field to the schedule's referrer term when they
-- are NULL (src/lib/referral-fees.ts, `storedTermMonths`), and once "rateScheduleId" is pinned that
-- schedule can no longer change under the client. Writing them would also invent a referrer window
-- the client was never sold. "termMonths" / "termEndsAt" were already stored on these rows before v1.5.
UPDATE "AttributedClient"
   SET "rateScheduleId" = p."rateScheduleId"
  FROM "Practitioner" p
 WHERE "AttributedClient"."practitionerId" = p."id"
   AND "AttributedClient"."rateScheduleId" IS NULL
   AND p."rateScheduleId" IS NOT NULL;
