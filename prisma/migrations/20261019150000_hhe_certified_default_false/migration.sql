-- Operator ruling 2026-10-15 (tsk_303ec99f): new practitioners do not get the 'HHE Certified'
-- badge by default; an admin grants it. Expand-only: changes the column default for future
-- inserts and touches no existing row (the pilot rows keep true).
ALTER TABLE "Practitioner" ALTER COLUMN "hheCertified" SET DEFAULT false;
