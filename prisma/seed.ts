import { PrismaClient, Role } from '@prisma/client';
import { ensureFlatSpecialty } from './taxonomy';

const prisma = new PrismaClient();

// Specialties are flat and named from each practitioner's own labels (see ./taxonomy): no
// parents, no seeded aliases.

// 60% GA / 40% other (operator directive).
// Coordinates are city centroids; per-practitioner jitter applied below.
const CITIES = [
  { slug: 'atlanta', name: 'Atlanta', state: 'GA', lat: 33.749, lng: -84.388 },
  { slug: 'savannah', name: 'Savannah', state: 'GA', lat: 32.0809, lng: -81.0912 },
  { slug: 'athens', name: 'Athens', state: 'GA', lat: 33.9519, lng: -83.3576 },
  { slug: 'macon', name: 'Macon', state: 'GA', lat: 32.8407, lng: -83.6324 },
  { slug: 'augusta', name: 'Augusta', state: 'GA', lat: 33.4735, lng: -82.0105 },
  { slug: 'decatur', name: 'Decatur', state: 'GA', lat: 33.7748, lng: -84.2963 },
  { slug: 'asheville', name: 'Asheville', state: 'NC', lat: 35.5951, lng: -82.5515 },
  { slug: 'boulder', name: 'Boulder', state: 'CO', lat: 40.015, lng: -105.2705 },
  { slug: 'austin', name: 'Austin', state: 'TX', lat: 30.2672, lng: -97.7431 },
  { slug: 'portland', name: 'Portland', state: 'OR', lat: 45.5152, lng: -122.6784 },
  { slug: 'nashville', name: 'Nashville', state: 'TN', lat: 36.1627, lng: -86.7816 },
  { slug: 'charleston', name: 'Charleston', state: 'SC', lat: 32.7765, lng: -79.9311 },
  { slug: 'sedona', name: 'Sedona', state: 'AZ', lat: 34.8697, lng: -111.761 },
];

type PractitionerSeed = {
  slug: string;
  displayName: string;
  email: string;
  citySlug: string;
  cityState: string;
  /** The practitioner's own specialty labels; each becomes a flat specialty of the same name. */
  specialties: string[];
  bio: string;
  yearsInPractice: number;
};

// 18 practitioners. 11 GA (61%), 7 non-GA (39%).
const PRACTITIONERS: PractitionerSeed[] = [
  // Atlanta (4)
  {
    slug: 'maya-sullivan',
    displayName: 'Dr. Maya Sullivan',
    email: 'maya.sullivan@example.com',
    citySlug: 'atlanta',
    cityState: 'GA',
    specialties: ['Functional Medicine', 'Hormone Balance'],
    bio: 'HHE-trained functional medicine practitioner helping Atlanta women rebalance hormones through root-cause investigation, comprehensive labs, and protocols built around real life.',
    yearsInPractice: 11,
  },
  {
    slug: 'jordan-beaumont',
    displayName: 'Jordan Beaumont',
    email: 'jordan.beaumont@example.com',
    citySlug: 'atlanta',
    cityState: 'GA',
    specialties: ['Gut Health'],
    bio: 'Recovering engineer turned gut-health practitioner. Specializes in SIBO, dysbiosis, and the inflammatory tail of long-term stress. Works with referring physicians across metro Atlanta.',
    yearsInPractice: 5,
  },
  {
    slug: 'naomi-pace',
    displayName: 'Naomi Pace, NTP',
    email: 'naomi.pace@example.com',
    citySlug: 'atlanta',
    cityState: 'GA',
    specialties: ['Holistic Nutrition', "Children's Holistic Health"],
    bio: 'Family nutrition built around what real Atlanta families actually eat. Pediatric and prenatal focus. Calm, non-judgmental, and grounded in food-first protocols.',
    yearsInPractice: 8,
  },
  {
    slug: 'marcus-whitfield',
    displayName: 'Marcus Whitfield',
    email: 'marcus.whitfield@example.com',
    citySlug: 'atlanta',
    cityState: 'GA',
    specialties: ['Herbal Medicine'],
    bio: 'Clinical herbalist working alongside Atlanta-area physicians. Bridges traditional plant medicine with functional lab work and pharmaceutical-aware safety protocols.',
    yearsInPractice: 16,
  },
  // Savannah (2)
  {
    slug: 'eliza-boudreaux',
    displayName: 'Eliza Boudreaux',
    email: 'eliza.boudreaux@example.com',
    citySlug: 'savannah',
    cityState: 'GA',
    specialties: ['Mind-Body Coaching', 'Stress / Sleep Optimization'],
    bio: 'Nervous-system regulation coach for chronically overworked Southerners. Sleep first; everything else follows. Polyvagal-informed, body-led, refreshingly non-woo.',
    yearsInPractice: 7,
  },
  {
    slug: 'theresa-holcombe',
    displayName: 'Theresa Holcombe',
    email: 'theresa.holcombe@example.com',
    citySlug: 'savannah',
    cityState: 'GA',
    specialties: ['Functional Medicine'],
    bio: 'Functional medicine for thyroid, autoimmune, and hormone-disrupted women. Twelve years post-pharmacy, now practicing the medicine she wishes she had been taught.',
    yearsInPractice: 12,
  },
  // Athens (2)
  {
    slug: 'cameron-liddell',
    displayName: 'Cameron Liddell',
    email: 'cameron.liddell@example.com',
    citySlug: 'athens',
    cityState: 'GA',
    specialties: ['Gut Health', 'Holistic Nutrition'],
    bio: 'Gut-brain axis specialist. Works closely with UGA students and faculty on stress-driven digestive issues, IBS, and the post-antibiotic restoration arc.',
    yearsInPractice: 6,
  },
  {
    slug: 'avery-tate',
    displayName: 'Avery Tate',
    email: 'avery.tate@example.com',
    citySlug: 'athens',
    cityState: 'GA',
    specialties: ['Hormone Balance'],
    bio: 'Cycle-syncing nutrition and hormone restoration. PCOS, perimenopause, fertility prep. Practical, lab-informed, and built around the actual hour you have in a day.',
    yearsInPractice: 4,
  },
  // Macon (1)
  {
    slug: 'sienna-galt',
    displayName: 'Sienna Galt',
    email: 'sienna.galt@example.com',
    citySlug: 'macon',
    cityState: 'GA',
    specialties: ["Children's Holistic Health"],
    bio: 'Pediatric holistic care for picky eaters, sensory-processing kids, and parents who want a calmer kitchen. Trauma-informed, gentle, and pragmatic.',
    yearsInPractice: 9,
  },
  // Augusta (1)
  {
    slug: 'devin-russo',
    displayName: 'Devin Russo',
    email: 'devin.russo@example.com',
    citySlug: 'augusta',
    cityState: 'GA',
    specialties: ['Stress / Sleep Optimization'],
    bio: 'Former ICU nurse, now insomnia-resolution specialist. Trauma-informed, evidence-driven, and unapologetically uninterested in sleep hygiene checklists that do not work.',
    yearsInPractice: 14,
  },
  // Decatur (1)
  {
    slug: 'phoebe-ash',
    displayName: 'Phoebe Ash',
    email: 'phoebe.ash@example.com',
    citySlug: 'decatur',
    cityState: 'GA',
    specialties: ['Holistic Nutrition', 'Herbal Medicine'],
    bio: 'Whole-food nutrition and Appalachian herbalism. Decatur farmers-market regular. Builds protocols around what is actually growing and seasonal in the Southeast.',
    yearsInPractice: 10,
  },
  // Asheville NC (1)
  {
    slug: 'river-calhoun',
    displayName: 'River Calhoun',
    email: 'river.calhoun@example.com',
    citySlug: 'asheville',
    cityState: 'NC',
    specialties: ['Herbal Medicine'],
    bio: 'Wildcrafted Appalachian herbal practice. Folk-tradition trained, clinically rigorous, and respected by referring MDs across western North Carolina.',
    yearsInPractice: 18,
  },
  // Boulder CO (1)
  {
    slug: 'indira-ashland',
    displayName: 'Indira Ashland',
    email: 'indira.ashland@example.com',
    citySlug: 'boulder',
    cityState: 'CO',
    specialties: ['Functional Medicine', 'Mind-Body Coaching'],
    bio: 'Altitude-adapted functional medicine. Mountain-athlete recovery, hormone protocols, and stress-load work for people whose lifestyle is the intervention they keep forgetting.',
    yearsInPractice: 13,
  },
  // Austin TX (1)
  {
    slug: 'daniela-rojas',
    displayName: 'Daniela Rojas',
    email: 'daniela.rojas@example.com',
    citySlug: 'austin',
    cityState: 'TX',
    specialties: ['Gut Health'],
    bio: 'Bilingual gut-health practitioner. SIBO, IBS, post-antibiotic recovery, and the gut-skin axis. Practice rooted in Latina family-food traditions.',
    yearsInPractice: 7,
  },
  // Portland OR (1)
  {
    slug: 'wren-kobayashi',
    displayName: 'Wren Kobayashi',
    email: 'wren.kobayashi@example.com',
    citySlug: 'portland',
    cityState: 'OR',
    specialties: ['Mind-Body Coaching'],
    bio: 'Somatic, trauma-informed coaching for chronic fatigue and burnout. Quiet, methodical, and built for high-functioning clients who are running on fumes.',
    yearsInPractice: 8,
  },
  // Nashville TN (1)
  {
    slug: 'hollis-brennan',
    displayName: 'Hollis Brennan',
    email: 'hollis.brennan@example.com',
    citySlug: 'nashville',
    cityState: 'TN',
    specialties: ['Hormone Balance', 'Functional Medicine'],
    bio: "Nashville's busy-mom hormone practice. PCOS, thyroid, perimenopause. Labs ordered, protocols built, follow-through scheduled. No vibes.",
    yearsInPractice: 6,
  },
  // Charleston SC (1)
  {
    slug: 'mira-pinckney',
    displayName: 'Mira Pinckney',
    email: 'mira.pinckney@example.com',
    citySlug: 'charleston',
    cityState: 'SC',
    specialties: ['Holistic Nutrition', "Children's Holistic Health"],
    bio: 'Lowcountry family nutrition. Food allergies, picky eating, and family-table strategy for parents who are done arguing about dinner.',
    yearsInPractice: 11,
  },
  // Sedona AZ (1)
  {
    slug: 'solene-marchetti',
    displayName: 'Solene Marchetti',
    email: 'solene.marchetti@example.com',
    citySlug: 'sedona',
    cityState: 'AZ',
    specialties: ['Mind-Body Coaching', 'Stress / Sleep Optimization'],
    bio: 'Energy-medicine-informed nervous-system work. Twenty-year practice. Quiet, steady, and trusted by referring providers across the Southwest.',
    yearsInPractice: 22,
  },
];

function deterministicJitter(seed: string): { dLat: number; dLng: number } {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h << 5) - h + seed.charCodeAt(i);
  const dLat = (((h >> 0) & 0xffff) / 0xffff - 0.5) * 0.08;
  const dLng = (((h >> 16) & 0xffff) / 0xffff - 0.5) * 0.08;
  return { dLat, dLng };
}

function buildSearchText(p: PractitionerSeed, cityName: string, specialtyNames: string[]) {
  return [p.displayName, p.bio, cityName, p.cityState, ...specialtyNames].join(' ');
}

async function main() {
  console.log('Resetting seedable data…');
  await prisma.practitionerSpecialty.deleteMany({});
  await prisma.practitioner.deleteMany({});
  await prisma.user.deleteMany({ where: { email: { endsWith: '@example.com' } } });
  await prisma.specialtyAlias.deleteMany({});
  await prisma.specialty.deleteMany({});
  await prisma.city.deleteMany({});

  console.log('Seeding cities…');
  const cityRows = new Map<string, { id: string; name: string; lat: number; lng: number }>();
  for (const c of CITIES) {
    const row = await prisma.city.create({
      data: { slug: c.slug, name: c.name, state: c.state },
    });
    cityRows.set(`${c.slug}|${c.state}`, { id: row.id, name: c.name, lat: c.lat, lng: c.lng });
  }

  console.log('Seeding practitioners…');

  for (const p of PRACTITIONERS) {
    const cityKey = `${p.citySlug}|${p.cityState}`;
    const city = cityRows.get(cityKey);
    if (!city) throw new Error(`City not found for practitioner ${p.slug}: ${cityKey}`);

    const { dLat, dLng } = deterministicJitter(p.slug);
    const lat = city.lat + dLat;
    const lng = city.lng + dLng;

    const specialtyRows: { id: string; name: string }[] = [];
    for (const label of p.specialties) specialtyRows.push(await ensureFlatSpecialty(prisma, label));
    const specialtyNames = specialtyRows.map((s) => s.name);

    const user = await prisma.user.create({
      data: {
        email: p.email,
        name: p.displayName,
        role: Role.PRACTITIONER,
      },
    });

    await prisma.practitioner.create({
      data: {
        userId: user.id,
        slug: p.slug,
        displayName: p.displayName,
        bio: p.bio,
        cityId: city.id,
        latitude: lat,
        longitude: lng,
        yearsInPractice: p.yearsInPractice,
        searchText: buildSearchText(p, city.name, specialtyNames),
        acceptedAt: new Date(),
        specialties: {
          create: specialtyRows.map((s, idx) => ({
            rawLabel: p.specialties[idx],
            sortOrder: idx,
            specialty: { connect: { id: s.id } },
          })),
        },
      },
    });
  }

  const totals = {
    specialties: await prisma.specialty.count(),
    cities: await prisma.city.count(),
    practitioners: await prisma.practitioner.count(),
    gaPractitioners: await prisma.practitioner.count({
      where: { city: { state: 'GA' } },
    }),
  };
  console.log('Seed complete:', totals);
  const gaPct = Math.round((totals.gaPractitioners / totals.practitioners) * 100);
  console.log(`GA share: ${totals.gaPractitioners}/${totals.practitioners} (${gaPct}%)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
