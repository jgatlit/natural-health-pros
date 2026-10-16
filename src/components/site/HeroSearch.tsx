'use client';

/*
 * The instrument. A directory homepage should begin the search, not link to it.
 *
 * Three controls, one row on desktop: what you need, where, go. The specialty
 * and location options are the live taxonomy — a select can only offer values
 * that return practitioners, so this control cannot promise a filter the
 * directory will not honour.
 *
 * It submits with a native GET form, so it works with JavaScript disabled and
 * before hydration. The action is the production /search URL; the hidden inputs
 * carry the InstantSearch parameter names verbatim (see lib/search-url.ts for
 * why they look like that).
 *
 * Motion here is a single spring on the submit control. Nothing else moves —
 * this is the one element on the page that must feel like a tool.
 */

import { useState } from 'react';
import { motion } from 'motion/react';
import { Search } from 'lucide-react';
import { useReducedMotion } from '@/lib/use-reduced-motion';
import { SITE_URL } from '@/lib/search-url';
import type { DirectoryCity, DirectorySpecialty } from '@/lib/directory';

export function HeroSearch({
  specialties,
  cities,
}: {
  specialties: DirectorySpecialty[];
  cities: DirectoryCity[];
}) {
  const reduced = useReducedMotion();
  const [specialty, setSpecialty] = useState('');
  const [city, setCity] = useState('');

  // pr-9 leaves room for the native select chevron, which otherwise crops the
  // longest option label; appearance-none would mean shipping a custom
  // dropdown, and a native select is the better control on a phone.
  //
  // No `outline-none` here. It sits in Tailwind's utilities layer and so beats
  // the :focus-visible rule in globals.css, which silently strips the focus
  // ring from the two most important controls on the page.
  const fieldClass =
    'h-12 w-full rounded-lg border border-border bg-white pl-3.5 pr-9 text-[0.9375rem] text-foreground shadow-none transition-colors hover:border-primary/40 focus:border-primary';

  return (
    <form action={`${SITE_URL}/search`} method="get" className="w-full">
      {/* Reproduces the InstantSearch routing contract without a JS round-trip. */}
      <input type="hidden" name="practitioners[refinementList][specialtyNames][0]" value={specialty} disabled={!specialty} />
      <input type="hidden" name="practitioners[refinementList][cityName][0]" value={city} disabled={!city} />

      {/* Elevation comes from the system's navy-tinted shadow scale, not a
          hand-rolled rgba — the tint is part of the token contract. */}
      <div
        className="grid gap-2.5 rounded-xl border border-border/80 bg-white/95 p-2.5 backdrop-blur sm:grid-cols-[1.25fr_1fr_auto] sm:gap-2"
        style={{ boxShadow: 'var(--shadow-elevated)' }}
      >
        <div>
          <label htmlFor="hero-specialty" className="sr-only">
            What do you need help with?
          </label>
          <select
            id="hero-specialty"
            value={specialty}
            onChange={(e) => setSpecialty(e.target.value)}
            className={fieldClass}
          >
            <option value="">What do you need help with?</option>
            {specialties.map((s) => (
              <option key={s.slug} value={s.name}>
                {s.name} ({s.count})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="hero-city" className="sr-only">
            Where?
          </label>
          <select
            id="hero-city"
            value={city}
            onChange={(e) => setCity(e.target.value)}
            className={fieldClass}
          >
            <option value="">Anywhere</option>
            {cities.map((c) => (
              <option key={`${c.slug}-${c.state}`} value={c.name}>
                {c.name === 'Virtual Practice' ? 'Virtual — anywhere' : `${c.name}, ${c.state}`} (
                {c.count})
              </option>
            ))}
          </select>
        </div>

        <motion.button
          type="submit"
          whileHover={reduced ? undefined : { scale: 1.02 }}
          whileTap={reduced ? undefined : { scale: 0.985 }}
          transition={{ type: 'spring', stiffness: 420, damping: 22 }}
          className="inline-flex h-12 items-center justify-center gap-2 rounded-lg px-6 text-[0.9375rem] font-medium text-white transition-shadow hover:[box-shadow:var(--shadow-glow-rose)]"
          style={{ background: 'var(--gradient-rose-cta)' }}
        >
          <Search className="h-4 w-4" aria-hidden="true" />
          Find a practitioner
        </motion.button>
      </div>

      <p className="mt-3 text-[0.8125rem] text-white/65">
        {cities.length === 1 && cities[0].name === 'Virtual Practice'
          ? 'Every practitioner listed today works virtually, so location is not a limit yet.'
          : 'Search by specialty, by place, or both.'}
      </p>
    </form>
  );
}
