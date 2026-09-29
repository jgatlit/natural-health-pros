import { describe, expect, it } from 'vitest';
import { getListed, trustRow } from '@/content/copy';

// The public practitioner block must not state a price, a percentage or "no commission".
// Operator ruling 2026-09-28: nothing numeric is public until Amy's terms are firm; exact rates
// are shown after sign-in. The homepage once said "No commission on your sessions" while the
// shipped structure charged 20% / 40% on sourced clients — this pins that it cannot come back.
describe('homepage practitioner copy', () => {
  const text = JSON.stringify(getListed);
  // "0%" is the one number that IS public: own and invited clients are always free (ruling
  // 2026-09-28). It is removed before checking so any OTHER figure still fails the test.
  const withoutZeroPercent = text.replaceAll('0%', '');

  it('states no price or percentage other than the public 0% promise', () => {
    expect(withoutZeroPercent).not.toMatch(/[$%]/);
    expect(withoutZeroPercent).not.toMatch(/\d/);
  });

  it('never claims there is no commission', () => {
    expect(text.toLowerCase()).not.toContain('no commission');
    expect(text.toLowerCase()).not.toContain('no cut');
  });

  it('presents Plan A and Plan B as equals — no tier language', () => {
    expect(getListed.plans.map((p) => p.name)).toEqual(['Plan A', 'Plan B']);
    expect(text.toLowerCase()).not.toMatch(/tier|recommended|best value|most popular/);
  });

  it('keeps the own-clients-are-0% and term-has-an-end promises', () => {
    expect(getListed.guarantees.map((g) => g.title)).toEqual(
      expect.arrayContaining([
        'Your own clients are always 0%',
        'Our share has an end date',
      ]),
    );
  });

  it('no longer asserts the unproven trust claims', () => {
    const row = trustRow.join(' ').toLowerCase();
    expect(row).not.toContain('credential-verified');
    expect(row).not.toContain('easy scheduling');
    expect(row).not.toContain('affordable');
  });
});
