import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

/**
 * Guards the defect class this repo keeps re-hitting: a capability that is complete, correct, and
 * unreachable.
 *
 * `startSubscriptionCheckout` shipped in PR #37 fully working and with NO caller. Nothing caught
 * it — tsc, lint, the suite and the build all pass on an exported function nobody invokes — so the
 * per-practitioner `metadata.practitioner_id` attribution that PR was sold on was never live, and
 * Layer X silently resolved payers by EMAIL for two and a half months. `publishOffering` had the
 * identical shape in the same PR, and `/api/cron/whop-reconcile` shipped unregistered in #55.
 *
 * The common cause is partitioning work by file: the producer gets an owner, the CONSUMER does
 * not, and every individual file is correct. Type checking cannot see it because an uncalled
 * export is perfectly valid TypeScript. So it is asserted structurally instead.
 *
 * This is deliberately a source-text check rather than a runtime one. The thing being asserted is
 * "a call site exists in the shipped tree", which is a property of the tree, not of any execution.
 */

const ROOT = join(__dirname, '..', 'src');
const ACTIONS = 'app/practitioners/[slug]/edit/actions.ts';

/** Server actions that perform a Whop network call and MUST be reachable from the UI. */
const MUST_HAVE_A_CALLER = [
  'startSubscriptionCheckout',
  'startWhopOnboarding',
  'openPayoutPortal',
  'publishOffering',
  'unpublishOffering',
  // Clients & Referrals (spec v1.4 §5). Every one of these writes a row that decides money — a
  // client-list entry makes sessions free, a referral makes somebody a payee — so an exported,
  // correct, callerless version of any of them is a feature that silently does not exist.
  'addClients',
  'inviteClients',
  'referClientByEmail',
  'createReferralLinkFor',
];

/**
 * Public flow routes that must be REACHABLE FROM THE UI, not merely by typing a URL.
 *
 * §17.4a landed, so `/practitioners/[slug]/book` is now LINKED and this is a real assertion
 * rather than a recorded gap. If a future change strips the profile CTAs, the flow silently
 * becomes URL-only again — which is exactly how startSubscriptionCheckout stayed correct,
 * exported and callerless for two and a half months.
 */
const FLOW_ROUTES = [{ path: '/practitioners/', segment: 'book', linked: true, owner: '§17.4a' }];

/**
 * `/r/[token]` is reachable by DESIGN from outside the product — a practitioner pastes it into a
 * message — so the "linked from a page" test above does not apply to it. What must be true is
 * that the app can still MINT one: a referral route with no way to create a link is the same
 * complete-but-unreachable shape, one step earlier in the chain.
 */
const REFERRAL_LINK_MINTERS = ['createReferralLink', 'referralUrl'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const actionsPath = files.find((f) => f.endsWith(ACTIONS.replace(/\//g, require('node:path').sep)));

describe('server-action reachability', () => {
  it('finds the actions module (guards the guard — a moved file must not silently pass)', () => {
    expect(actionsPath).toBeTruthy();
  });

  for (const name of MUST_HAVE_A_CALLER) {
    it(`${name} is exported AND has a call site outside its own module`, () => {
      const source = readFileSync(actionsPath!, 'utf8');
      expect(source, `${name} is no longer exported from actions.ts`).toContain(
        `export async function ${name}`,
      );

      const callers = files.filter((f) => {
        if (f === actionsPath) return false;
        return new RegExp(`\\b${name}\\b`).test(readFileSync(f, 'utf8'));
      });

      expect(
        callers,
        `${name} has no consumer anywhere in src/. It is exported, correct, and unreachable — ` +
          `the exact shape that left Layer X resolving payers by email for 2.5 months.`,
      ).not.toHaveLength(0);
    });
  }
});

describe('flow routes are reachable from the UI', () => {
  for (const route of FLOW_ROUTES) {
    it(`${route.segment} flow — linked from a page: expected ${route.linked}`, () => {
      // A URL-construction match alone is NOT enough. Broadened that far, the assertion was
      // satisfied by src/lib/profile-ctas.ts — a pure helper rendered by nothing — so deleting
      // the profile CTAs entirely left this green, which is precisely the regression it exists
      // to catch. Require BOTH halves of the chain:
      //   1. a COMPONENT (not a lib) constructs a /book target, and
      //   2. the profile page actually renders that component.
      const componentsLinking = files.filter(
        (f) =>
          !f.includes(`${sep}book${sep}`) &&
          f.includes(`${sep}components${sep}`) &&
          /\/book\?|chooserOptionTarget|bookingLinkTarget|offeringTarget/.test(
            readFileSync(f, 'utf8'),
          ),
      );
      const profilePage = files.find(
        (f) => f.endsWith(`${sep}practitioners${sep}[slug]${sep}page.tsx`),
      );
      const profileSrc = profilePage ? readFileSync(profilePage, 'utf8') : '';
      const rendered = componentsLinking.some((f) => {
        const name = f.split(sep).pop()!.replace(/\.tsx?$/, '');
        return new RegExp(`<${name}\\b`).test(profileSrc);
      });
      const linked = componentsLinking.length > 0 && rendered;
      expect(
        linked,
        route.linked
          ? `The ${route.segment} flow has no link from any page — it is reachable only by typing a URL.`
          : `The ${route.segment} flow is now linked. ${route.owner} has landed, so flip \`linked\` to true and keep this asserted.`,
      ).toBe(route.linked);
    });
  }
});

describe('the referral link can actually be minted and rendered', () => {
  for (const name of REFERRAL_LINK_MINTERS) {
    it(`${name} has a consumer outside src/lib`, () => {
      const callers = files.filter(
        (f) => !f.includes(`${sep}lib${sep}`) && new RegExp(`\\b${name}\\b`).test(readFileSync(f, 'utf8')),
      );
      expect(
        callers,
        `${name} is exported but nothing outside src/lib uses it — a referral system that cannot ` +
          `issue a link is complete and unreachable.`,
      ).not.toHaveLength(0);
    });
  }

  it('the /r/[token] route exists and is explicitly dynamic', () => {
    // A prerendered `/r/[token]` would serve ONE cached response to every visitor, so every
    // referral would resolve to the same touch and the same referrer would be paid for all of
    // them. `force-dynamic` is the declaration; the build table's ƒ/○ column is the proof.
    const route = files.find((f) => f.endsWith(`${sep}app${sep}r${sep}[token]${sep}route.ts`));
    expect(route, 'src/app/r/[token]/route.ts is missing').toBeTruthy();
    expect(readFileSync(route!, 'utf8')).toContain("export const dynamic = 'force-dynamic'");
  });
});

describe('cron routes are registered', () => {
  // /api/cron/whop-reconcile shipped in #55 written, documented, and absent from vercel.json —
  // so nothing would ever have invoked it. The route compiling is not evidence it runs.
  it('every src/app/api/cron/* route appears in vercel.json crons', () => {
    const cronDir = join(ROOT, 'app', 'api', 'cron');
    const routes = readdirSync(cronDir).filter((d) =>
      statSync(join(cronDir, d)).isDirectory(),
    );
    const vercelJson = readFileSync(join(__dirname, '..', 'vercel.json'), 'utf8');
    const scheduled = (JSON.parse(vercelJson).crons ?? []) as Array<{ path: string }>;
    const scheduledPaths = scheduled.map((c) => c.path);

    for (const route of routes) {
      expect(
        scheduledPaths,
        `/api/cron/${route} exists but is not in vercel.json — it would never run.`,
      ).toContain(`/api/cron/${route}`);
    }
  });
});

/**
 * The flow URL is an unauthenticated bearer credential, and §10 mails it out.
 *
 * `BookingIntent.id` is a cuid — `c` + a base36 MILLISECOND timestamp + a monotonic counter + a
 * per-process host fingerprint — so ids minted in a known window are enumerable at far better
 * than random odds. `publicToken` exists so the public URL is 244 bits of randomness instead.
 *
 * Asserted structurally because the regression is silent: swapping `publicToken` back to `id` in
 * a redirect or a lookup type-checks, passes every behavioural test (both are strings that
 * address the same row), renders identically, and quietly re-opens enumeration. There is no
 * runtime assertion that can tell "the right string" from "a string".
 */
describe('the public booking URL is addressed by a random token, never the cuid id', () => {
  const flowDir = join(ROOT, 'app/practitioners/[slug]/book');

  it('resolves the flow route and its action by publicToken', () => {
    for (const file of ['[token]/page.tsx', '[token]/actions.ts']) {
      const src = readFileSync(join(flowDir, file), 'utf8');
      expect(src, `${file} must look the intent up by publicToken`).toMatch(/publicToken:\s*(params\.)?token/);
    }
  });

  it('redirects capture to the token, so a fresh lead never lands on an enumerable URL', () => {
    const src = readFileSync(join(flowDir, 'actions.ts'), 'utf8');
    const redirectLine = src.split('\n').find((l) => l.includes('/book/${'));
    expect(redirectLine, 'capture must redirect into the flow').toBeDefined();
    expect(redirectLine).toContain('publicToken');
    expect(redirectLine).not.toContain('intent.id');
  });

  it('never builds a /book/ URL out of an intent id anywhere in src', () => {
    const offenders = walk(ROOT)
      .filter((f) => /\.tsx?$/.test(f))
      .flatMap((f) =>
        readFileSync(f, 'utf8')
          .split('\n')
          .map((line, i) => ({ f, i: i + 1, line }))
          .filter(({ line }) => /\/book\/\$\{[^}]*\bid\b[^}]*\}/.test(line)),
      );
    expect(offenders.map((o) => `${o.f}:${o.i}`)).toEqual([]);
  });
});

/**
 * Who may be BOOKED is a different question from who may be DISCOVERED, and the booking surfaces
 * must all answer it the same way.
 *
 * Asserted structurally because the unit tests cannot reach two of the four surfaces: the capture
 * page and the flow page are server components with no test harness, so re-adding `listedWhere()`
 * to either — or dropping `bookableWhere()` from either — passes the entire suite while breaking
 * the behaviour this exists to guarantee (an unlisted practitioner is bookable; a retired one is
 * not). That is the same defect class as the callerless server action above.
 */
describe('every booking surface gates on bookableWhere, never listedWhere', () => {
  const SURFACES = [
    'app/practitioners/[slug]/book/page.tsx',
    'app/practitioners/[slug]/book/actions.ts',
    'app/practitioners/[slug]/book/[token]/page.tsx',
    'app/practitioners/[slug]/book/[token]/actions.ts',
    'app/api/cron/booking-sweep/route.ts',
  ];

  it.each(SURFACES)('%s calls bookableWhere()', (rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    expect(src).toContain('bookableWhere()');
  });

  it.each(SURFACES)('%s does NOT re-introduce listedWhere()', (rel) => {
    // Comments legitimately name it to explain the distinction, so they are stripped first: a
    // CALL is the regression, a mention is documentation.
    const code = readFileSync(join(ROOT, rel), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(code).not.toContain('listedWhere()');
  });

  it('keeps listedWhere on the DISCOVERY surfaces, which is what it is for', () => {
    for (const rel of ['lib/directory.ts']) {
      expect(readFileSync(join(ROOT, rel), 'utf8')).toContain('listedWhere()');
    }
  });
});
