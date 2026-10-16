-- Specialties are the practitioner's own words (operator ruling 2026-10-15: "Specialties should
-- not be awarded/added by the application"; "categorize them independently, no parent").
-- Data only, no schema change: "parentId" stays in the schema (expand-only) but is cleared.
-- Every statement is guarded on exact slugs/strings so a second run changes nothing.

-- 1. No parent groupings.
UPDATE "Specialty" SET "parentId" = NULL WHERE "parentId" IS NOT NULL;

-- 2. Specialties named from the practitioners' own labels.
INSERT INTO "Specialty" ("id", "slug", "name", "status")
SELECT 'spc_' || md5(v.slug), v.slug, v.name, 'PROPOSED'::"SpecialtyStatus"
FROM (VALUES
  ('microcurrent-therapy', 'Microcurrent Therapy'),
  ('self-government-relationship-mentor', 'Self-Government / Relationship Mentor'),
  ('energy-frequency-support', 'Energy & Frequency Support'),
  ('chronic-pain-anxiety-support', 'Chronic Pain & Anxiety Support'),
  ('certified-crystal-healer', 'Certified Crystal Healer'),
  ('root-cause-chronic-disease', 'Root-Cause Chronic Disease'),
  ('spiritual-chronic-illness-support', 'Spiritual & Chronic-Illness Support'),
  ('ao-scan', 'AO Scan'),
  ('mind-body-stress-release', 'Mind-Body Stress Release'),
  ('mindset-and-neuroscience-to-rewire-the-brain', 'Mindset and Neuroscience to Rewire the Brain'),
  ('performance-nutrition-biohacking', 'Performance Nutrition & Biohacking')
) AS v(slug, name)
ON CONFLICT ("slug") DO NOTHING;

-- 3. Repoint the 12 links whose label had been mapped to a different concept. rawLabel and
--    sortOrder are kept; a link that would collide with the composite PK is left alone.
WITH moves(practitioner_slug, raw_label, old_slug, new_slug) AS (VALUES
  ('dd-black', 'Microcurrent Therapy', 'bodywork-manual-therapy', 'microcurrent-therapy'),
  ('dd-black', 'Self-Government / Relationship Mentor', 'conscious-parenting', 'self-government-relationship-mentor'),
  ('debbie-hoelscher', 'Energy & Frequency Support', 'energy-medicine', 'energy-frequency-support'),
  ('emily-teale', 'Chronic Pain & Anxiety Support', 'stress-sleep-optimization', 'chronic-pain-anxiety-support'),
  ('jeanette-ricci', 'Certified Crystal Healer', 'energy-medicine', 'certified-crystal-healer'),
  ('jill-staudacher', 'Root-Cause Chronic Disease', 'functional-medicine', 'root-cause-chronic-disease'),
  ('julie-ericson', 'Spiritual & Chronic-Illness Support', 'energy-medicine', 'spiritual-chronic-illness-support'),
  ('juliette-steven', 'AO Scan', 'energy-medicine', 'ao-scan'),
  ('kellie-johnston', 'Board Certified Holistic Health Practitioner (BC-HHP)', 'holistic-health-coaching', 'holistic-health-practitioner'),
  ('kellie-johnston', 'Mind-Body Stress Release', 'stress-sleep-optimization', 'mind-body-stress-release'),
  ('sarah-schindler', 'Mindset and neuroscience to rewire the brain', 'mind-body-coaching', 'mindset-and-neuroscience-to-rewire-the-brain'),
  ('tara-garrison', 'Performance Nutrition & Biohacking', 'holistic-nutrition', 'performance-nutrition-biohacking')
)
UPDATE "PractitionerSpecialty" ps
SET "specialtyId" = n."id"
FROM moves m
JOIN "Practitioner" p ON p."slug" = m.practitioner_slug
JOIN "Specialty" o ON o."slug" = m.old_slug
JOIN "Specialty" n ON n."slug" = m.new_slug
WHERE ps."practitionerId" = p."id"
  AND ps."specialtyId" = o."id"
  AND ps."rawLabel" = m.raw_label
  AND NOT EXISTS (
    SELECT 1 FROM "PractitionerSpecialty" x
    WHERE x."practitionerId" = ps."practitionerId" AND x."specialtyId" = n."id"
  );

-- 4. Aliases spelled exactly like those labels (stored lowercased/trimmed) follow them.
WITH moves(label, new_slug) AS (VALUES
  ('microcurrent therapy', 'microcurrent-therapy'),
  ('self-government / relationship mentor', 'self-government-relationship-mentor'),
  ('energy & frequency support', 'energy-frequency-support'),
  ('chronic pain & anxiety support', 'chronic-pain-anxiety-support'),
  ('certified crystal healer', 'certified-crystal-healer'),
  ('root-cause chronic disease', 'root-cause-chronic-disease'),
  ('spiritual & chronic-illness support', 'spiritual-chronic-illness-support'),
  ('ao scan', 'ao-scan'),
  ('board certified holistic health practitioner (bc-hhp)', 'holistic-health-practitioner'),
  ('mind-body stress release', 'mind-body-stress-release'),
  ('mindset and neuroscience to rewire the brain', 'mindset-and-neuroscience-to-rewire-the-brain'),
  ('performance nutrition & biohacking', 'performance-nutrition-biohacking')
)
UPDATE "SpecialtyAlias" a
SET "specialtyId" = n."id", "updatedAt" = CURRENT_TIMESTAMP
FROM moves m
JOIN "Specialty" n ON n."slug" = m.new_slug
WHERE a."label" = m.label
  AND a."specialtyId" <> n."id";

-- 5. Remove the grouping/placeholder nodes nobody holds any more. Only when nothing references
--    them: no practitioner link, no child, no merge pointer.
DELETE FROM "SpecialtyAlias" a
USING "Specialty" s
WHERE a."specialtyId" = s."id"
  AND s."slug" IN ('functional-medicine', 'bodywork-manual-therapy', 'herbal-medicine',
                   'craniosacral-therapy', 'terrain-health', 'agentic-workflow-design',
                   'business-process-automation')
  AND NOT EXISTS (SELECT 1 FROM "PractitionerSpecialty" ps WHERE ps."specialtyId" = s."id")
  AND NOT EXISTS (SELECT 1 FROM "Specialty" c WHERE c."parentId" = s."id")
  AND NOT EXISTS (SELECT 1 FROM "Specialty" m WHERE m."mergedIntoId" = s."id");

DELETE FROM "Specialty" s
WHERE s."slug" IN ('functional-medicine', 'bodywork-manual-therapy', 'herbal-medicine',
                   'craniosacral-therapy', 'terrain-health', 'agentic-workflow-design',
                   'business-process-automation')
  AND NOT EXISTS (SELECT 1 FROM "PractitionerSpecialty" ps WHERE ps."specialtyId" = s."id")
  AND NOT EXISTS (SELECT 1 FROM "Specialty" c WHERE c."parentId" = s."id")
  AND NOT EXISTS (SELECT 1 FROM "Specialty" m WHERE m."mergedIntoId" = s."id");

-- 6. searchText is parts joined by ' \n ' (buildSearchText), and used to end with canonical
--    names INCLUDING the parent roll-up. Drop a segment that is exactly one of the former
--    grouping names unless the practitioner still holds a specialty of that name or wrote it
--    themselves (a rawLabel, case-insensitive). Remaining segments keep their order.
WITH grouping_names(name) AS (VALUES
  ('Functional Medicine'), ('Bodywork & Manual Therapy'), ('Energy Medicine'),
  ('Mind-Body Coaching'), ('Holistic Nutrition'), ('Stress / Sleep Optimization'),
  ('Conscious Parenting'), ('Holistic Health Coaching'), ('Herbal Medicine'),
  ('CranioSacral Therapy')
),
rebuilt AS (
  SELECT p."id", array_to_string(array_agg(u.seg ORDER BY u.ord), E' \n ') AS txt
  FROM "Practitioner" p
  CROSS JOIN LATERAL unnest(string_to_array(p."searchText", E' \n ')) WITH ORDINALITY AS u(seg, ord)
  WHERE p."searchText" IS NOT NULL
    AND NOT (
      u.seg IN (SELECT name FROM grouping_names)
      AND NOT EXISTS (
        SELECT 1 FROM "PractitionerSpecialty" ps
        JOIN "Specialty" s ON s."id" = ps."specialtyId"
        WHERE ps."practitionerId" = p."id" AND s."name" = u.seg
      )
      AND NOT EXISTS (
        SELECT 1 FROM "PractitionerSpecialty" ps
        WHERE ps."practitionerId" = p."id" AND lower(trim(ps."rawLabel")) = lower(u.seg)
      )
    )
  GROUP BY p."id"
)
UPDATE "Practitioner" p
SET "searchText" = r.txt
FROM rebuilt r
WHERE p."id" = r."id"
  AND p."searchText" IS DISTINCT FROM r.txt;
