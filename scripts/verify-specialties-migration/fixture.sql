-- Fixture mirroring the production shape before 20261015230000_specialties_own_words
-- (the parent tree, the 12 concept-substituted links, their aliases, the roll-up in searchText),
-- plus negative controls. Local Docker only.

INSERT INTO "Specialty" ("id", "slug", "name", "status") VALUES
  ('s_fm',   'functional-medicine',          'Functional Medicine',          'ACTIVE'),
  ('s_hn',   'holistic-nutrition',           'Holistic Nutrition',           'ACTIVE'),
  ('s_mbc',  'mind-body-coaching',           'Mind-Body Coaching',           'ACTIVE'),
  ('s_em',   'energy-medicine',              'Energy Medicine',              'ACTIVE'),
  ('s_bmt',  'bodywork-manual-therapy',      'Bodywork & Manual Therapy',    'ACTIVE'),
  ('s_hb',   'hormone-balance',              'Hormone Balance',              'ACTIVE'),
  ('s_gh',   'gut-health',                   'Gut Health',                   'ACTIVE'),
  ('s_htma', 'hair-tissue-mineral-analysis', 'Hair Tissue Mineral Analysis', 'ACTIVE'),
  ('s_tn',   'therapeutic-nutrition',        'Therapeutic Nutrition',        'ACTIVE'),
  ('s_chh',  'childrens-holistic-health',    'Children''s Holistic Health',  'ACTIVE'),
  ('s_sso',  'stress-sleep-optimization',    'Stress / Sleep Optimization',  'ACTIVE'),
  ('s_hyp',  'hypnotherapy',                 'Hypnotherapy',                 'ACTIVE'),
  ('s_mbsr', 'mindfulness-mbsr',             'Mindfulness & MBSR',           'ACTIVE'),
  ('s_cp',   'conscious-parenting',          'Conscious Parenting',          'ACTIVE'),
  ('s_yoga', 'yoga',                         'Yoga',                         'ACTIVE'),
  ('s_rei',  'reiki',                        'Reiki',                        'ACTIVE'),
  ('s_fzt',  'foot-zone-therapy',            'Foot Zone Therapy',            'ACTIVE'),
  ('s_cst',  'craniosacral-therapy',         'CranioSacral Therapy',         'ACTIVE'),
  ('s_hhc',  'holistic-health-coaching',     'Holistic Health Coaching',     'ACTIVE'),
  ('s_hhp',  'holistic-health-practitioner', 'Holistic Health Practitioner', 'ACTIVE'),
  ('s_herb', 'herbal-medicine',              'Herbal Medicine',              'ACTIVE'),
  ('s_th',   'terrain-health',               'Terrain Health',               'PROPOSED'),
  ('s_awd',  'agentic-workflow-design',      'Agentic Workflow Design',      'PROPOSED'),
  ('s_bpa',  'business-process-automation',  'Business Process Automation',  'PROPOSED');

UPDATE "Specialty" SET "parentId" = 's_fm'  WHERE "id" IN ('s_hb', 's_gh', 's_htma');
UPDATE "Specialty" SET "parentId" = 's_hn'  WHERE "id" IN ('s_tn', 's_chh');
UPDATE "Specialty" SET "parentId" = 's_mbc' WHERE "id" IN ('s_sso', 's_hyp', 's_mbsr', 's_cp', 's_yoga');
UPDATE "Specialty" SET "parentId" = 's_em'  WHERE "id" IN ('s_rei');
UPDATE "Specialty" SET "parentId" = 's_bmt' WHERE "id" IN ('s_fzt', 's_cst');

INSERT INTO "SpecialtyAlias" ("id", "label", "specialtyId", "source", "status", "updatedAt") VALUES
  ('a01', 'root cause', 's_fm', 'CURATED', 'APPROVED', '2026-01-01'),
  ('a02', 'autoimmune', 's_fm', 'IMPORT', 'APPROVED', '2026-01-01'),
  ('a03', 'root-cause chronic disease', 's_fm', 'IMPORT', 'APPROVED', '2026-01-01'),
  ('a04', 'anxiety', 's_sso', 'CURATED', 'APPROVED', '2026-01-01'),
  ('a05', 'chronic pain & anxiety support', 's_sso', 'IMPORT', 'APPROVED', '2026-01-01'),
  ('a06', 'mind-body stress release', 's_sso', 'IMPORT', 'PENDING', '2026-01-01'),
  ('a07', 'ao scan', 's_em', 'IMPORT', 'APPROVED', '2026-01-01'),
  ('a08', 'certified crystal healer', 's_em', 'IMPORT', 'APPROVED', '2026-01-01'),
  ('a09', 'energy & frequency support', 's_em', 'IMPORT', 'APPROVED', '2026-01-01'),
  ('a10', 'spiritual & chronic-illness support', 's_em', 'IMPORT', 'PENDING', '2026-01-01'),
  ('a11', 'microcurrent therapy', 's_bmt', 'IMPORT', 'APPROVED', '2026-01-01'),
  ('a12', 'self-government / relationship mentor', 's_cp', 'IMPORT', 'APPROVED', '2026-01-01'),
  ('a13', 'board certified holistic health practitioner (bc-hhp)', 's_hhc', 'IMPORT', 'APPROVED', '2026-01-01'),
  ('a14', 'mindset and neuroscience to rewire the brain', 's_mbc', 'PRACTITIONER', 'PENDING', '2026-01-01'),
  ('a15', 'performance nutrition & biohacking', 's_hn', 'IMPORT', 'APPROVED', '2026-01-01'),
  ('a16', 'herbs', 's_herb', 'CURATED', 'APPROVED', '2026-01-01'),
  ('a17', 'terrain', 's_th', 'PRACTITIONER', 'PENDING', '2026-01-01'),
  ('a18', 'holistic health coach', 's_hhc', 'IMPORT', 'APPROVED', '2026-01-01'),
  ('a19', 'automation', 's_bpa', 'PRACTITIONER', 'PENDING', '2026-01-01');

INSERT INTO "User" ("id", "email", "updatedAt")
SELECT 'u_' || s, s || '@fixture.test', '2026-01-01'
FROM unnest(ARRAY['dd-black','debbie-hoelscher','emily-teale','jeanette-ricci','jill-staudacher',
  'julie-ericson','juliette-steven','kellie-johnston','sarah-schindler','tara-garrison','amy',
  'jeanette501234','jonathan','murraydaionna','tammi-cross','gayle-parker-kelley','jgatlit']) AS s;

INSERT INTO "Practitioner" ("id", "userId", "slug", "displayName", "searchText", "updatedAt") VALUES
  ('p_dd', 'u_dd-black', 'dd-black', 'DD Black',
    E'DD Black \n Bio of DD \n Microcurrent Therapy \n Self-Government / Relationship Mentor \n Reiki \n Bodywork & Manual Therapy \n Conscious Parenting \n Mind-Body Coaching \n Reiki \n Energy Medicine', '2026-01-01'),
  ('p_deb', 'u_debbie-hoelscher', 'debbie-hoelscher', 'Debbie Hoelscher',
    E'Debbie Hoelscher \n Energy & Frequency Support \n Energy Medicine', '2026-01-01'),
  ('p_em', 'u_emily-teale', 'emily-teale', 'Emily Teale',
    E'Emily Teale \n Chronic Pain & Anxiety Support \n Foot Zone Therapy \n Stress / Sleep Optimization \n Mind-Body Coaching \n Foot Zone Therapy \n Bodywork & Manual Therapy', '2026-01-01'),
  ('p_jr', 'u_jeanette-ricci', 'jeanette-ricci', 'Jeanette Ricci',
    E'Jeanette Ricci \n Certified Crystal Healer \n Reiki \n Energy Medicine \n Reiki', '2026-01-01'),
  ('p_jill', 'u_jill-staudacher', 'jill-staudacher', 'Jill Staudacher',
    E'Jill Staudacher \n Root-Cause Chronic Disease \n Hair Tissue Mineral Analysis \n Functional Medicine \n Hair Tissue Mineral Analysis \n Functional Medicine', '2026-01-01'),
  ('p_jul', 'u_julie-ericson', 'julie-ericson', 'Julie Ericson',
    E'Julie Ericson \n Spiritual & Chronic-Illness Support \n Energy Medicine', '2026-01-01'),
  ('p_js', 'u_juliette-steven', 'juliette-steven', 'Juliette Steven',
    E'Juliette Steven \n AO Scan \n Energy Medicine', '2026-01-01'),
  ('p_kj', 'u_kellie-johnston', 'kellie-johnston', 'Kellie Johnston',
    E'Kellie Johnston \n Board Certified Holistic Health Practitioner (BC-HHP) \n Mind-Body Stress Release \n Holistic Health Coaching \n Stress / Sleep Optimization \n Mind-Body Coaching', '2026-01-01'),
  ('p_ss', 'u_sarah-schindler', 'sarah-schindler', 'Sarah Schindler',
    E'Sarah Schindler \n Mindset and neuroscience to rewire the brain \n Hypnosis \n Mind-Body Coaching \n Hypnotherapy', '2026-01-01'),
  ('p_tg', 'u_tara-garrison', 'tara-garrison', 'Tara Garrison',
    E'Tara Garrison \n Performance Nutrition & Biohacking \n Holistic Health Coach \n Holistic Nutrition \n Holistic Health Coaching', '2026-01-01'),
  -- negative control: wrote "Functional medicine" herself (rawLabel), so the segment stays
  ('p_amy', 'u_amy', 'amy', 'Amy Sprouse',
    E'Amy Sprouse \n Functional medicine \n Hormone Balance \n Functional Medicine \n Herbal Medicine', '2026-01-01'),
  ('p_j5', 'u_jeanette501234', 'jeanette501234', 'Jeanette', E'Jeanette \n Yoga \n Mind-Body Coaching', '2026-01-01'),
  ('p_jon', 'u_jonathan', 'jonathan', 'Jonathan', E'Jonathan', '2026-01-01'),
  ('p_md', 'u_murraydaionna', 'murraydaionna', 'Murray Daionna', NULL, '2026-01-01'),
  -- negative control: same label as a moved row, but not one of the 12, so it is not moved
  ('p_tc', 'u_tammi-cross', 'tammi-cross', 'Tammi Cross', E'Tammi Cross \n AO Scan \n Energy Medicine', '2026-01-01'),
  ('p_gpk', 'u_gayle-parker-kelley', 'gayle-parker-kelley', 'Gayle Parker-Kelley',
    E'Gayle Parker-Kelley \n Gut Health \n Therapeutic Nutrition \n Functional Medicine \n Holistic Nutrition', '2026-01-01'),
  -- negative control: holds business-process-automation, so that node must survive
  ('p_jg', 'u_jgatlit', 'jgatlit', 'J Gatlit', E'J Gatlit \n Business Process Automation', '2026-01-01');

INSERT INTO "PractitionerSpecialty" ("practitionerId", "specialtyId", "rawLabel", "sortOrder") VALUES
  ('p_dd', 's_bmt', 'Microcurrent Therapy', 0),
  ('p_dd', 's_cp', 'Self-Government / Relationship Mentor', 1),
  ('p_dd', 's_rei', 'Reiki', 2),
  ('p_deb', 's_em', 'Energy & Frequency Support', 0),
  ('p_em', 's_sso', 'Chronic Pain & Anxiety Support', 0),
  ('p_em', 's_fzt', 'Foot Zone Therapy', 1),
  ('p_jr', 's_em', 'Certified Crystal Healer', 0),
  ('p_jr', 's_rei', 'Reiki', 1),
  ('p_jill', 's_fm', 'Root-Cause Chronic Disease', 0),
  ('p_jill', 's_htma', 'Hair Tissue Mineral Analysis', 1),
  ('p_jul', 's_em', 'Spiritual & Chronic-Illness Support', 0),
  ('p_js', 's_em', 'AO Scan', 0),
  ('p_kj', 's_hhc', 'Board Certified Holistic Health Practitioner (BC-HHP)', 0),
  ('p_kj', 's_sso', 'Mind-Body Stress Release', 1),
  ('p_ss', 's_mbc', 'Mindset and neuroscience to rewire the brain', 0),
  ('p_ss', 's_hyp', 'Hypnosis', 1),
  ('p_tg', 's_hn', 'Performance Nutrition & Biohacking', 0),
  ('p_tg', 's_hhc', 'Holistic Health Coach', 1),
  ('p_amy', 's_hb', 'Functional medicine', 0),
  ('p_amy', 's_gh', 'Hormone Balance', 1),
  ('p_j5', 's_yoga', 'Yoga', 0),
  ('p_tc', 's_em', 'AO Scan', 0),
  ('p_gpk', 's_gh', 'Gut Health', 0),
  ('p_gpk', 's_tn', 'Therapeutic Nutrition', 1),
  ('p_jg', 's_bpa', 'Business Process Automation', 0);
