-- Plan A list price (vault task tsk_142334399d2a4e3da1cb). Data only, expand-only.

-- The schedule whose Plan A price is the regular price, read by getPlanAListSchedule(). Copy only:
-- a practitioner priced below it sees the regular price struck through. Inserted only when that
-- schedule exists, and DO NOTHING on conflict so a re-apply never overrides an operator's change.
INSERT INTO "PlatformSetting" ("key", "value", "createdAt", "updatedAt")
SELECT 'plan_a_list_rate_schedule_id', "id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "RateSchedule"
WHERE "id" = 'rs_go_forward_2026_10'
ON CONFLICT ("key") DO NOTHING;
