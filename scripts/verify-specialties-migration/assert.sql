-- Expected state after 20261015230000_specialties_own_words is applied to fixture.sql.
-- Raises (non-zero psql exit with ON_ERROR_STOP) on the first mismatch.

DO $$
DECLARE
  n int;
  got text;
  r record;
BEGIN
  SELECT count(*) INTO n FROM "Specialty" WHERE "parentId" IS NOT NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'parentId still set on % rows', n; END IF;

  SELECT count(*) INTO n FROM "Specialty"
  WHERE "status" = 'PROPOSED' AND "id" = 'spc_' || md5("slug") AND "slug" IN (
    'microcurrent-therapy', 'self-government-relationship-mentor', 'energy-frequency-support',
    'chronic-pain-anxiety-support', 'certified-crystal-healer', 'root-cause-chronic-disease',
    'spiritual-chronic-illness-support', 'ao-scan', 'mind-body-stress-release',
    'mindset-and-neuroscience-to-rewire-the-brain', 'performance-nutrition-biohacking');
  IF n <> 11 THEN RAISE EXCEPTION 'expected 11 new PROPOSED specialties, got %', n; END IF;

  -- the 12 links: practitioner, rawLabel, expected slug, expected sortOrder
  FOR r IN SELECT * FROM (VALUES
    ('dd-black', 'Microcurrent Therapy', 'microcurrent-therapy', 0),
    ('dd-black', 'Self-Government / Relationship Mentor', 'self-government-relationship-mentor', 1),
    ('debbie-hoelscher', 'Energy & Frequency Support', 'energy-frequency-support', 0),
    ('emily-teale', 'Chronic Pain & Anxiety Support', 'chronic-pain-anxiety-support', 0),
    ('jeanette-ricci', 'Certified Crystal Healer', 'certified-crystal-healer', 0),
    ('jill-staudacher', 'Root-Cause Chronic Disease', 'root-cause-chronic-disease', 0),
    ('julie-ericson', 'Spiritual & Chronic-Illness Support', 'spiritual-chronic-illness-support', 0),
    ('juliette-steven', 'AO Scan', 'ao-scan', 0),
    ('kellie-johnston', 'Board Certified Holistic Health Practitioner (BC-HHP)', 'holistic-health-practitioner', 0),
    ('kellie-johnston', 'Mind-Body Stress Release', 'mind-body-stress-release', 1),
    ('sarah-schindler', 'Mindset and neuroscience to rewire the brain', 'mindset-and-neuroscience-to-rewire-the-brain', 0),
    ('tara-garrison', 'Performance Nutrition & Biohacking', 'performance-nutrition-biohacking', 0),
    -- untouched controls
    ('dd-black', 'Reiki', 'reiki', 2),
    ('tammi-cross', 'AO Scan', 'energy-medicine', 0),
    ('amy', 'Functional medicine', 'hormone-balance', 0),
    ('jgatlit', 'Business Process Automation', 'business-process-automation', 0)
  ) AS v(pslug, raw, sslug, ord) LOOP
    SELECT s."slug" || '#' || ps."sortOrder" INTO got
    FROM "PractitionerSpecialty" ps
    JOIN "Practitioner" p ON p."id" = ps."practitionerId"
    JOIN "Specialty" s ON s."id" = ps."specialtyId"
    WHERE p."slug" = r.pslug AND ps."rawLabel" = r.raw;
    IF got IS DISTINCT FROM r.sslug || '#' || r.ord THEN
      RAISE EXCEPTION 'link % / %: expected %#%, got %', r.pslug, r.raw, r.sslug, r.ord, got;
    END IF;
  END LOOP;

  SELECT count(*) INTO n FROM "PractitionerSpecialty";
  IF n <> 25 THEN RAISE EXCEPTION 'expected 25 PractitionerSpecialty rows, got %', n; END IF;

  FOR r IN SELECT * FROM (VALUES
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
    ('performance nutrition & biohacking', 'performance-nutrition-biohacking'),
    ('anxiety', 'stress-sleep-optimization'),
    ('holistic health coach', 'holistic-health-coaching'),
    ('automation', 'business-process-automation')
  ) AS v(label, sslug) LOOP
    SELECT s."slug" INTO got FROM "SpecialtyAlias" a JOIN "Specialty" s ON s."id" = a."specialtyId"
    WHERE a."label" = r.label;
    IF got IS DISTINCT FROM r.sslug THEN
      RAISE EXCEPTION 'alias %: expected %, got %', r.label, r.sslug, got;
    END IF;
  END LOOP;

  -- source/status untouched on a moved alias
  SELECT "source" || '/' || "status" INTO got FROM "SpecialtyAlias" WHERE "label" = 'mind-body stress release';
  IF got <> 'IMPORT/PENDING' THEN RAISE EXCEPTION 'alias source/status changed: %', got; END IF;

  SELECT count(*) INTO n FROM "SpecialtyAlias" WHERE "label" IN ('root cause', 'autoimmune', 'herbs', 'terrain');
  IF n <> 0 THEN RAISE EXCEPTION 'aliases of deleted nodes survived: %', n; END IF;

  SELECT count(*) INTO n FROM "Specialty" WHERE "slug" IN ('functional-medicine', 'bodywork-manual-therapy',
    'herbal-medicine', 'craniosacral-therapy', 'terrain-health', 'agentic-workflow-design');
  IF n <> 0 THEN RAISE EXCEPTION 'expected 6 nodes deleted, % remain', n; END IF;
  SELECT count(*) INTO n FROM "Specialty" WHERE "slug" = 'business-process-automation';
  IF n <> 1 THEN RAISE EXCEPTION 'a held node (business-process-automation) was deleted'; END IF;
  SELECT count(*) INTO n FROM "Specialty";
  IF n <> 29 THEN RAISE EXCEPTION 'expected 29 specialties, got %', n; END IF;

  FOR r IN SELECT * FROM (VALUES
    ('dd-black', E'DD Black \n Bio of DD \n Microcurrent Therapy \n Self-Government / Relationship Mentor \n Reiki \n Reiki'),
    ('debbie-hoelscher', E'Debbie Hoelscher \n Energy & Frequency Support'),
    ('emily-teale', E'Emily Teale \n Chronic Pain & Anxiety Support \n Foot Zone Therapy \n Foot Zone Therapy'),
    ('jeanette-ricci', E'Jeanette Ricci \n Certified Crystal Healer \n Reiki \n Reiki'),
    ('jill-staudacher', E'Jill Staudacher \n Root-Cause Chronic Disease \n Hair Tissue Mineral Analysis \n Hair Tissue Mineral Analysis'),
    ('julie-ericson', E'Julie Ericson \n Spiritual & Chronic-Illness Support'),
    ('juliette-steven', E'Juliette Steven \n AO Scan'),
    ('kellie-johnston', E'Kellie Johnston \n Board Certified Holistic Health Practitioner (BC-HHP) \n Mind-Body Stress Release'),
    ('sarah-schindler', E'Sarah Schindler \n Mindset and neuroscience to rewire the brain \n Hypnosis \n Hypnotherapy'),
    ('tara-garrison', E'Tara Garrison \n Performance Nutrition & Biohacking \n Holistic Health Coach \n Holistic Health Coaching'),
    ('amy', E'Amy Sprouse \n Functional medicine \n Hormone Balance \n Functional Medicine'),
    ('jeanette501234', E'Jeanette \n Yoga'),
    ('jonathan', E'Jonathan'),
    ('tammi-cross', E'Tammi Cross \n AO Scan \n Energy Medicine'),
    ('gayle-parker-kelley', E'Gayle Parker-Kelley \n Gut Health \n Therapeutic Nutrition'),
    ('jgatlit', E'J Gatlit \n Business Process Automation')
  ) AS v(pslug, txt) LOOP
    SELECT "searchText" INTO got FROM "Practitioner" WHERE "slug" = r.pslug;
    IF got IS DISTINCT FROM r.txt THEN
      RAISE EXCEPTION 'searchText %: expected [%], got [%]', r.pslug, r.txt, got;
    END IF;
  END LOOP;
  SELECT count(*) INTO n FROM "Practitioner" WHERE "slug" = 'murraydaionna' AND "searchText" IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'null searchText was touched'; END IF;

  RAISE NOTICE 'ALL ASSERTIONS PASSED';
END $$;
