-- The 11 own-words specialties created by 20261015230000_specialties_own_words were inserted
-- PROPOSED. The practitioners they belong to were on ACTIVE nodes before, and the homepage
-- filters show ACTIVE only, so leaving them PROPOSED would drop those practitioners out of the
-- hero select and the specialty field. Data only; touches exactly these slugs, and only while
-- they are still PROPOSED (an admin's later MERGE is left alone). A second run changes nothing.
UPDATE "Specialty"
SET "status" = 'ACTIVE'::"SpecialtyStatus"
WHERE "status" = 'PROPOSED'::"SpecialtyStatus"
  AND "slug" IN (
    'microcurrent-therapy',
    'self-government-relationship-mentor',
    'energy-frequency-support',
    'chronic-pain-anxiety-support',
    'certified-crystal-healer',
    'root-cause-chronic-disease',
    'spiritual-chronic-illness-support',
    'ao-scan',
    'mind-body-stress-release',
    'mindset-and-neuroscience-to-rewire-the-brain',
    'performance-nutrition-biohacking'
  );
