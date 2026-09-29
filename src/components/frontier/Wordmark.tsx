/*
 * The brand mark is the Natural Health Pros symbol: a practitioner figure rising from leaves.
 * Files live in public/brand/ and are the same artwork (natural-health-pros-d5-icon-only).
 *
 * TWO FILES, ONE DESIGN. The header sits on the navy field, and the symbol's dark right-hand
 * leaf (#2F5B46) is only ~1.8:1 against it — it drops out and the mark reads lopsided. The
 * `-on-dark` file is transparent like the original and lightens ONLY that one leaf (~3.3:1);
 * every other shape is identical. Use the plain file on light surfaces.
 *
 * This replaces the earlier node-and-filament glyph, which was drawn specifically to avoid
 * leaf imagery. The brand has since chosen a leaf mark deliberately (2026-09-29).
 *
 * The image is decorative (alt=""): the wordmark text beside it already names the brand, and
 * announcing it twice is noise for screen readers. No client hooks are needed any more, so this
 * is no longer a client component.
 */

import Image from 'next/image';
import { cn } from '@/lib/utils';

const MARK = '/brand/natural-health-pros-mark.svg';
const MARK_ON_DARK = '/brand/natural-health-pros-mark-on-dark.svg';

export function Wordmark({
  className,
  tone = 'ink',
}: {
  className?: string;
  tone?: 'ink' | 'inverse';
}) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <Image
        src={tone === 'inverse' ? MARK_ON_DARK : MARK}
        alt=""
        width={914}
        height={840}
        unoptimized
        priority={tone === 'inverse'} // the header instance is above the fold: load it eagerly, not lazily
        className="h-9 w-auto shrink-0"
      />
      <span
        className={cn(
          'whitespace-nowrap font-serif text-[0.9375rem] font-semibold leading-none tracking-[-0.01em] sm:text-[1.0625rem]',
          tone === 'inverse' ? 'text-white' : 'text-foreground',
        )}
      >
        Natural Health Pros
      </span>
    </span>
  );
}

/**
 * Custom trust check. A generic lucide <Check> would read as chrome; this is
 * drawn to the brand's stroke weight and sits inside a token-coloured well.
 */
export function TrustCheck({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={cn('h-5 w-5 shrink-0', className)} fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="9" fill="var(--secondary)" />
      <path
        d="M6 10.4 L8.8 13.2 L14 7.4"
        stroke="var(--sage-deep)"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Section rule. Not a 1px border: a hand-weighted filament that thins toward
 * both ends, echoing the mark's connective lines.
 */
export function FilamentRule({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 600 8"
      className={cn('h-2 w-full', className)}
      fill="none"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="filament-fade" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stopColor="var(--border)" stopOpacity="0" />
          <stop offset="50%" stopColor="var(--field)" stopOpacity="0.55" />
          <stop offset="100%" stopColor="var(--border)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d="M0 4 H600" stroke="url(#filament-fade)" strokeWidth="1.25" />
    </svg>
  );
}
