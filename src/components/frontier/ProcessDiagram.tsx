'use client';

/*
 * Class 6 — ILLUSTRATIVE.
 *
 * Three steps drawn on one continuous filament, because the steps really are a
 * sequence — you cannot compare before you search, or book before you compare.
 * The numbering earns its place for the same reason. The filament is the same
 * connective line as the wordmark and the practice field: one visual idea, used
 * three times, rather than three unrelated motifs.
 *
 * D4: prefers-reduced-motion → the path renders complete and every step is
 *     visible at full opacity from first paint.
 * D7: N/A — inline SVG with no external dependency.
 */

import { useEffect, useRef } from 'react';
import { useReducedMotion } from '@/lib/use-reduced-motion';
import { revealWhenVisible } from '@/lib/reveal';

const STEPS = [
  {
    n: '01',
    title: 'Search by what you need',
    body: 'Start with a specialty — gut health, hormone balance, grief, sleep. Or type what is actually going on and let the directory match it.',
  },
  {
    n: '02',
    title: 'Read the training, not the ad',
    body: 'Every profile carries the practitioner’s formal training, their specialties in their own words, and how they work.',
  },
  {
    n: '03',
    title: 'Book straight with them',
    body: 'You book on the practitioner’s own calendar and pay their listed price. Your session is between you and them.',
  },
];

export function ProcessDiagram() {
  const reduced = useReducedMotion();
  const pathRef = useRef<SVGPathElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const path = pathRef.current;
    const wrap = wrapRef.current;
    if (!path || !wrap) return;

    if (reduced) return;

    const len = path.getTotalLength();
    path.style.strokeDasharray = `${len}`;
    path.style.strokeDashoffset = `${len}`;

    return revealWhenVisible(
      wrap,
      () => {
        path.style.transition = 'stroke-dashoffset 1400ms cubic-bezier(0.33, 1, 0.68, 1)';
        path.style.strokeDashoffset = '0';
      },
      { threshold: 0.25 },
    );
  }, [reduced]);

  return (
    <div ref={wrapRef}>
      {/*
        Desktop: one filament carries the three steps. The nodes sit at 1/6,
        1/2 and 5/6 of the width — the centres of the three grid columns below —
        so the drawing lines up with the content it describes.
        preserveAspectRatio is left at its default: stretching the viewBox
        distorts the stroke into an invisible hairline.
      */}
      <svg
        viewBox="0 0 900 48"
        className="mb-2 hidden h-12 w-full md:block"
        fill="none"
        aria-hidden="true"
      >
        <path
          ref={pathRef}
          d="M150 34 C 300 34, 300 12, 450 12 C 600 12, 600 34, 750 34"
          stroke="var(--field)"
          strokeWidth="2"
          strokeLinecap="round"
          opacity="0.65"
        />
        <circle cx="150" cy="34" r="5" fill="var(--cta)" />
        <circle cx="450" cy="12" r="5" fill="var(--cta)" />
        <circle cx="750" cy="34" r="5" fill="var(--cta)" />
      </svg>

      <ol className="grid gap-8 md:grid-cols-3 md:gap-10">
        {STEPS.map((s) => (
          <li key={s.n} className="relative">
            <span className="font-mono text-[11px] font-medium tracking-[0.18em] text-cta">{s.n}</span>
            <h3 className="mt-3 font-serif text-xl leading-snug text-foreground">{s.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
