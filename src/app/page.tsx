import type { Metadata } from 'next';
import { Sparkles, ArrowRight } from 'lucide-react';
import { PracticeFieldLazy } from '@/components/frontier/LazyFrontier';
import { SpecialtyField } from '@/components/frontier/SpecialtyField';
import { GenerativeWash } from '@/components/frontier/GenerativeWash';
import { SessionLoop } from '@/components/frontier/SessionLoop';
import { DirectoryRail } from '@/components/frontier/DirectoryRail';
import { ProcessDiagram } from '@/components/frontier/ProcessDiagram';
import { ScopeBoundary } from '@/components/frontier/ScopeBoundary';
import { Ledger } from '@/components/frontier/Ledger';
import { TrustCheck } from '@/components/frontier/Wordmark';
import { SiteHeader } from '@/components/site/SiteHeader';
import { siteIdentity } from '@/lib/site-identity';
import { SiteFooter } from '@/components/site/SiteFooter';
import { HeroSearch } from '@/components/site/HeroSearch';
import { StructuredData } from '@/components/site/StructuredData';
import { getDirectory } from '@/lib/directory';
import { getListed, hero, trustRow } from '@/content/copy';
import { searchUrl, SITE_URL } from '@/lib/search-url';
import type { FailureKind } from '@/components/frontier/PipelineFailure';

// The directory changes when a practitioner completes their profile or a trial
// lapses, and neither event revalidates a static page. Do not remove.
export const dynamic = 'force-dynamic';

const DESCRIPTION =
  'Find trained holistic health professionals — coaches, nutritional counselors, gut health and energy medicine practitioners — and book directly.';

// Route-level facts the root layout deliberately leaves unset, because setting
// them there would canonicalise every page in the site to the home page.
// `openGraph` replaces the parent object wholesale rather than merging, so the
// inherited fields are restated.
export const metadata: Metadata = {
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: 'Natural Health Pros',
    title: 'Natural Health Pros — Natural Health Professional Directory',
    description: DESCRIPTION,
    locale: 'en_US',
  },
};

/**
 * D7 verification hatch. `?pipelineFailure=video-load` forces the SessionLoop
 * into its real failure path so the overlay contract can be exercised on a
 * working build. It only ever turns a component OFF — there is no code path
 * where this makes a broken component look healthy.
 */
const FAILURE_KINDS: FailureKind[] = [
  'webgl-unavailable',
  'webgl-context-lost',
  'canvas-unavailable',
  'video-load',
  'video-playback',
];

function parseFailure(value: string | string[] | undefined): FailureKind | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return FAILURE_KINDS.find((k) => k === v);
}

/**
 * Each component only accepts the failure kinds it can actually produce, so
 * `?pipelineFailure=video-load` does not also push a WebGL scene into a state
 * describing a video that never existed.
 */
function only(kind: FailureKind | undefined, allowed: FailureKind[]): FailureKind | undefined {
  return kind && allowed.includes(kind) ? kind : undefined;
}

export default async function Home({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const forcedFailure = parseFailure(searchParams?.pipelineFailure);
  const { practitioners, specialties, specialtyLinks, cities, facts } = await getDirectory();

  // Header identity — now shared, because the header is no longer homepage-only. The
  // signedIn/profileHref distinction that used to be explained here lives in siteIdentity().
  const { profileHref, signedIn } = await siteIdentity();

  // Field density is the real directory: one node per listed practitioner,
  // grouped by how many specialties they hold.
  const fieldGroups = practitioners.map((p) => p.specialties.length);

  const ledger = [
    { value: facts.practitionerCount, label: 'Practitioners listed today' },
    { value: facts.specialtyCount, label: 'Specialties represented' },
    { value: 100, suffix: '%', label: 'Formally trained in their specialty' },
    { value: facts.practitionerCount, label: 'Available for virtual sessions' },
  ];

  return (
    <>
      <StructuredData practitioners={practitioners} description={DESCRIPTION} />
      <SiteHeader profileHref={profileHref} signedIn={signedIn} />

      <main id="main">
        {/* ── HERO ─────────────────────────────────────────────────────────
            Dominant: the search instrument. Ambient: the practice field.
            One foreground class, one background class. */}
        <section
          className="relative isolate overflow-hidden pb-20 pt-32 sm:pb-28 sm:pt-40"
          style={{ background: 'var(--gradient-nav-bar)' }}
          data-surface="field"
        >
          <div className="absolute inset-0 opacity-90">
            <PracticeFieldLazy
              nodeCount={practitioners.length}
              groups={fieldGroups}
              forceFailure={only(forcedFailure, ['webgl-unavailable', 'webgl-context-lost'])}
            />
          </div>
          {/* Legibility scrim — the type sits in the atmosphere, not on a band,
              so the field is held back under the column rather than everywhere. */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                'radial-gradient(120% 80% at 20% 45%, rgba(20,36,58,0.92) 0%, rgba(20,36,58,0.55) 45%, rgba(20,36,58,0.1) 100%)',
            }}
          />

          <div className="relative mx-auto max-w-6xl px-4 sm:px-6">
            <div className="max-w-3xl">
              <p className="eyebrow inline-flex items-center gap-2 rounded-full border border-white/20 px-3 py-1.5 text-white/75">
                <Sparkles className="h-3 w-3" aria-hidden="true" />
                {facts.practitionerCount} trained practitioners · {facts.specialtyCount} specialties
              </p>

              <h1 className="mt-6 max-w-2xl font-serif text-[2.5rem] leading-[1.06] tracking-[-0.02em] text-white sm:text-6xl">
                {hero.title}
              </h1>

              <p className="mt-5 max-w-xl text-lg leading-relaxed text-white/80 sm:text-xl">
                {hero.subhead}
              </p>

              <div className="mt-9">
                <HeroSearch specialties={specialties} cities={cities} />
              </div>

              <ul className="mt-8 grid max-w-2xl gap-x-6 gap-y-3 sm:grid-cols-2">
                {trustRow.map((item) => (
                  <li key={item} className="flex items-center gap-2.5 text-sm text-white/85">
                    <TrustCheck />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* ── POSITIONING LINE ─────────────────────────────────────────────
            The strongest voice signal in the client's copy gets its own beat,
            set large, with nothing competing for attention. */}
        <section className="relative overflow-hidden border-b border-border bg-white">
          <div className="mx-auto max-w-4xl px-4 py-20 sm:px-6 sm:py-28">
            <p className="font-serif text-2xl leading-[1.32] tracking-[-0.01em] text-foreground sm:text-[2.125rem]">
              {hero.positioningLine}
            </p>
            <p className="mt-6 max-w-xl text-base leading-relaxed text-muted-foreground">
              {hero.body}
            </p>
          </div>
        </section>

        {/* ── LEDGER ───────────────────────────────────────────────────── */}
        <section className="border-b border-border bg-white">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
            <Ledger entries={ledger} />
          </div>
        </section>

        {/* ── DIRECTORY RAIL ───────────────────────────────────────────── */}
        <section className="bg-white py-20 sm:py-28">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="eyebrow text-cta">The directory</p>
                <h2 className="mt-3 max-w-xl font-serif text-3xl leading-tight tracking-[-0.015em] sm:text-[2.5rem]">
                  Everyone listed here trained for it.
                </h2>
              </div>
              <a
                href={searchUrl()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-primary/50 hover:bg-accent"
              >
                See all {facts.practitionerCount}
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            </div>
            <DirectoryRail practitioners={practitioners} />
          </div>
        </section>

        {/* ── HOW IT WORKS ─────────────────────────────────────────────── */}
        <section id="how-it-works" className="scroll-mt-20 border-y border-border sage-wash py-20 sm:py-28">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <p className="eyebrow text-[var(--sage-deep)]">How it works</p>
            <h2 className="mt-3 max-w-lg font-serif text-3xl leading-tight tracking-[-0.015em] sm:text-[2.5rem]">
              Three steps, and none of them are a waiting room.
            </h2>
            <div className="mt-12">
              <ProcessDiagram />
            </div>
          </div>
        </section>

        {/* ── VIDEO ────────────────────────────────────────────────────── */}
        <section className="bg-white py-20 sm:py-28">
          <div className="mx-auto max-w-5xl px-4 sm:px-6">
            <SessionLoop forceFailure={only(forcedFailure, ['video-load', 'video-playback'])} />
          </div>
        </section>

        {/* ── SCOPE (is / is not) — Generative texture behind ───────────── */}
        <section id="scope" className="relative isolate scroll-mt-20 overflow-hidden bg-white py-20 sm:py-28">
          <GenerativeWash className="pointer-events-none absolute inset-0 -z-10 opacity-60" />
          <div className="relative mx-auto max-w-6xl px-4 sm:px-6">
            <p className="eyebrow text-cta">Plainly</p>
            <h2 className="mt-3 max-w-xl font-serif text-3xl leading-tight tracking-[-0.015em] sm:text-[2.5rem]">
              What this directory is, and what it is not.
            </h2>
            <div className="mt-12">
              <ScopeBoundary />
            </div>
          </div>
        </section>

        {/* ── 3D INTERACTIVE ───────────────────────────────────────────── */}
        <section className="border-y border-border bg-white py-20 sm:py-28">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <div className="mb-10 max-w-xl">
              <p className="eyebrow text-cta">Browse by training</p>
              <h2 className="mt-3 font-serif text-3xl leading-tight tracking-[-0.015em] sm:text-[2.5rem]">
                Every specialty currently on the directory.
              </h2>
              <p className="mt-4 text-base leading-relaxed text-muted-foreground">
                Node size is how many practitioners hold that specialty. Nothing here is aspirational
                — if it is on the field, someone listed today practises it.
              </p>
            </div>
            <SpecialtyField specialties={specialties} links={specialtyLinks} />
          </div>
        </section>

        {/* ── GET LISTED (Layer X) ─────────────────────────────────────────
            Two plans at EQUAL weight — Amy: "tiers imply hierarchy", so no highlighted card and no
            "recommended" badge. No prices or percentages here (operator ruling 2026-09-28); the
            exact rates are shown after sign-in, in the plan choice on the edit page. */}
        <section
          id="get-listed"
          className="relative isolate scroll-mt-20 overflow-hidden py-20 sm:py-28"
          style={{ background: 'var(--gradient-nav-bar)' }}
          data-surface="field"
        >
          <div className="relative mx-auto max-w-6xl px-4 sm:px-6">
            <div className="max-w-3xl">
              <p className="eyebrow text-rose-light/80">{getListed.eyebrow}</p>
              <h2 className="mt-3 font-serif text-3xl leading-tight tracking-[-0.015em] text-white sm:text-[2.5rem]">
                {getListed.heading}
              </h2>
              <p className="mt-5 max-w-2xl text-base leading-relaxed text-white/75">
                {getListed.body}
              </p>
            </div>

            <h3 className="sr-only">{getListed.plansHeading}</h3>
            <div className="mt-10 grid gap-5 sm:grid-cols-2">
              {getListed.plans.map((plan) => (
                <div
                  key={plan.name}
                  className="rounded-2xl border border-white/15 bg-white/[0.06] p-7 backdrop-blur"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="font-serif text-2xl text-white">{plan.name}</p>
                    <p className="text-sm text-white/60">{plan.kicker}</p>
                  </div>
                  <p className="mt-4 text-base leading-relaxed text-white/80">{plan.body}</p>
                </div>
              ))}
            </div>

            <ul className="mt-10 grid gap-x-8 gap-y-6 border-t border-white/15 pt-8 md:grid-cols-3">
              {getListed.guarantees.map((g) => (
                <li key={g.title}>
                  <p className="text-base font-medium text-white">{g.title}</p>
                  <p className="mt-2 text-[0.9375rem] leading-relaxed text-white/70">{g.body}</p>
                </li>
              ))}
            </ul>

            <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3">
              <a
                href={`${SITE_URL}/onboarding`}
                className="inline-flex h-12 items-center justify-center rounded-lg px-8 text-[0.9375rem] font-medium text-white transition-shadow hover:[box-shadow:var(--shadow-glow-rose)]"
                style={{ background: 'var(--gradient-rose-cta)' }}
              >
                {getListed.cta}
              </a>
              <a
                href={`${SITE_URL}/auth/signin`}
                className="text-sm text-white/80 underline-offset-4 transition-colors hover:text-white hover:underline"
              >
                {getListed.secondary}
              </a>
              <p className="text-sm text-white/60">{getListed.ratesNote}</p>
            </div>
          </div>
        </section>

        {/* ── CLOSING CTA ──────────────────────────────────────────────── */}
        <section className="bg-white py-20 text-center sm:py-28">
          <div className="mx-auto max-w-2xl px-4 sm:px-6">
            <h2 className="font-serif text-3xl leading-tight tracking-[-0.015em] sm:text-[2.5rem]">
              {hero.primaryCta}
            </h2>
            <a
              href={searchUrl()}
              className="mt-8 inline-flex h-12 items-center justify-center gap-2 rounded-lg px-7 text-[0.9375rem] font-medium text-white transition-shadow hover:[box-shadow:var(--shadow-glow-rose)]"
              style={{ background: 'var(--gradient-rose-cta)' }}
            >
              Search the directory
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </a>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
