'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export type EditSideNavEntry = {
  id: string;
  label: string;
  deferred?: boolean;
  children?: readonly EditSideNavEntry[];
};

// Matches the scroll-mt-24 every anchor carries, so a clicked target sits exactly on the line.
const READING_LINE = 96;
const HOLD_MS = 700;

function flatten(entries: readonly EditSideNavEntry[]): EditSideNavEntry[] {
  return entries.flatMap((e) => [e, ...(e.children ? flatten(e.children) : [])]);
}

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function readActive(order: readonly string[]): string | null {
  const els = order
    .map((id) => document.getElementById(id))
    .filter((el): el is HTMLElement => el !== null)
    .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  if (els.length === 0) return null;
  if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2) {
    return els[els.length - 1].id;
  }
  let current: string | null = null;
  for (const el of els) {
    if (el.getBoundingClientRect().top > READING_LINE + 2) break;
    current = el.id;
  }
  return current;
}

// replaceState keeps history.state as-is: that is what keeps Next's router state intact. Next's
// own refresh later rewrites the URL without the hash; the highlight does not depend on it.
export function jumpToSection(id: string): boolean {
  const target = document.getElementById(id);
  if (!target) return false;
  target.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  window.history.replaceState(window.history.state, '', `#${id}`);
  const focusable = target.querySelector<HTMLElement>('h1, h2, h3') ?? target;
  if (!focusable.hasAttribute('tabindex')) focusable.setAttribute('tabindex', '-1');
  focusable.focus({ preventScroll: true });
  return true;
}

export function EditSideNav({ entries }: { entries: readonly EditSideNavEntry[] }) {
  const [present, setPresent] = useState<Set<string> | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const desktopRef = useRef<HTMLElement>(null);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const holdRef = useRef<() => void>(() => {});

  useEffect(() => {
    const found = new Set<string>();
    for (const e of flatten(entries)) if (document.getElementById(e.id)) found.add(e.id);
    setPresent(found);
    const fromHash = decodeURIComponent(window.location.hash.slice(1));
    if (fromHash && found.has(fromHash)) setActive(fromHash);
  }, [entries]);

  const visible = useMemo(() => {
    if (!present) return entries.filter((e) => !e.deferred);
    return entries
      .filter((e) => present.has(e.id))
      .map((e) => (e.children ? { ...e, children: e.children.filter((c) => present.has(c.id)) } : e));
  }, [entries, present]);

  const order = useMemo(() => flatten(visible).map((e) => e.id), [visible]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as HTMLElement | null)?.closest?.('[data-edit-nav] a[href^="#"]');
      if (!link) return;
      const id = decodeURIComponent(link.getAttribute('href')!.slice(1));
      // Registered on window in the capture phase so it runs, and calls preventDefault, before
      // UnsavedChangesBar's document-level capture listener: a same-page jump is not leaving.
      if (jumpToSection(id)) {
        e.preventDefault();
        setActive(id);
        holdRef.current();
        if (detailsRef.current) detailsRef.current.open = false;
      }
    };
    window.addEventListener('click', onClick, true);
    return () => window.removeEventListener('click', onClick, true);
  }, []);

  // A reading line, not an IntersectionObserver band: a band leaves short trailing cards and the
  // gaps between sub-sections with no owner. The active entry is the last anchor at or above the
  // line, so a gap keeps the previous entry, and the page bottom always belongs to the last one.
  // A click holds its entry until the programmatic scroll ends, so Profile stays Profile.
  useEffect(() => {
    let frame = 0;
    let locked = false;
    let timer = 0;
    const release = () => {
      locked = false;
      window.clearTimeout(timer);
    };
    holdRef.current = () => {
      locked = true;
      window.clearTimeout(timer);
      timer = window.setTimeout(release, HOLD_MS);
    };
    const compute = () => {
      frame = 0;
      if (locked) return;
      const next = readActive(order);
      if (next) setActive(next);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(compute);
    };
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('scrollend', release);
    schedule();
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scrollend', release);
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      holdRef.current = () => {};
    };
  }, [order]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const d = detailsRef.current;
      if (e.key !== 'Escape' || !d?.open) return;
      d.open = false;
      d.querySelector('summary')?.focus();
    };
    const onPointer = (e: MouseEvent) => {
      const d = detailsRef.current;
      if (d?.open && !d.contains(e.target as Node)) d.open = false;
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onPointer);
    };
  }, []);

  useEffect(() => {
    const nav = desktopRef.current;
    if (!active || !nav || nav.scrollHeight <= nav.clientHeight) return;
    nav.querySelector('[aria-current="location"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const activeLabel = flatten(visible).find((e) => e.id === active)?.label ?? null;
  const parentOfActive = visible.find((e) => e.children?.some((c) => c.id === active))?.id ?? null;

  const linkClass = (id: string, nested: boolean) =>
    cn(
      'block rounded-md border-l-2 py-1.5 text-sm transition-colors hover:bg-muted hover:text-foreground',
      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
      nested ? 'pl-5 pr-2 text-xs' : 'pl-3 pr-2',
      active === id
        ? 'border-primary bg-primary/10 font-medium text-foreground'
        : id === parentOfActive
          ? 'border-transparent font-medium text-foreground'
          : 'border-transparent text-muted-foreground',
    );

  const list = (items: readonly EditSideNavEntry[], nested = false) => (
    <ul className={nested ? 'mt-0.5 space-y-0.5' : 'space-y-0.5'}>
      {items.map((e) => (
        <li key={e.id}>
          <a
            href={`#${e.id}`}
            aria-current={active === e.id ? 'location' : undefined}
            className={linkClass(e.id, nested)}
          >
            {e.label}
          </a>
          {e.children && e.children.length > 0 && list(e.children, true)}
        </li>
      ))}
    </ul>
  );

  return (
    <>
      <div data-edit-nav="mobile" className="sticky top-0 z-30 -mx-4 border-b bg-card/95 px-4 py-2 backdrop-blur lg:hidden">
        <details ref={detailsRef} className="group relative">
          <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-2 rounded-md border bg-card px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
            <span className="min-w-0 truncate">
              Jump to{activeLabel && <span className="font-normal text-muted-foreground">: {activeLabel}</span>}
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden />
          </summary>
          <nav
            aria-label="Edit sections"
            className="absolute inset-x-0 top-full mt-1 max-h-[60vh] overflow-y-auto rounded-md border bg-card p-2 shadow-lg"
          >
            {list(visible)}
          </nav>
        </details>
      </div>

      <aside className="hidden lg:block">
        <nav
          ref={desktopRef}
          data-edit-nav="desktop"
          aria-label="Edit sections"
          className="sticky top-6 max-h-[calc(100vh-3rem)] overflow-y-auto"
        >
          {list(visible)}
        </nav>
      </aside>
    </>
  );
}
