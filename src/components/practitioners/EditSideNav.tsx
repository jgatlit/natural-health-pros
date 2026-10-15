'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
const SETTLE_MS = 150;
const USER_SCROLL_PX = 4;
const RECENT_INPUT_MS = 1000;
const LATE_TARGET_RETRY_MS = 250;
const LATE_TARGET_TRIES = 40;
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
const INTERACTIVE =
  'input, textarea, select, button, summary, a[href], [contenteditable], ' +
  '[role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], [role="listbox"], ' +
  '[role="slider"], [role="combobox"], [role="textbox"], [role="radio"], [role="checkbox"], ' +
  '[role="switch"], [role="spinbutton"]';

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
  const holdRef = useRef<(id: string) => void>(() => {});
  const orderRef = useRef<string[]>([]);
  const scheduleRef = useRef<() => void>(() => {});
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  // The hash entry, kept until a real user scroll releases it. A ref (not state, not consumed on
  // read) so it survives StrictMode's mount/unmount/mount and is set before its target exists.
  const hashHold = useRef<string | null>(null);
  const hashApplied = useRef(false);

  const measurePresent = useCallback(() => {
    const found = new Set<string>();
    for (const e of flatten(entriesRef.current)) if (document.getElementById(e.id)) found.add(e.id);
    setPresent(found);
  }, []);

  useEffect(() => {
    measurePresent();
    if (hashApplied.current) return;
    hashApplied.current = true;
    const fromHash = decodeURIComponent(window.location.hash.slice(1));
    if (fromHash && flatten(entries).some((e) => e.id === fromHash)) {
      hashHold.current = fromHash;
      setActive(fromHash);
      setPresent((prev) => new Set(prev).add(fromHash));
    }
  }, [entries, measurePresent]);

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
        hashHold.current = null;
        holdRef.current(id);
        if (detailsRef.current) detailsRef.current.open = false;
      }
    };
    window.addEventListener('click', onClick, true);
    return () => window.removeEventListener('click', onClick, true);
  }, []);

  // A reading line, not an IntersectionObserver band: a band leaves short trailing cards and the
  // gaps between sub-sections with no owner. The active entry is the last anchor at or above the
  // line, so a gap keeps the previous entry, the page bottom belongs to the last one, and above the
  // first anchor the first entry is active rather than a stale one.
  //
  // A clicked or hash-loaded entry is HELD until the user scrolls on their own: a target near the
  // page bottom can never reach the line, so no timer can stand in for "the user moved on". Wheel,
  // touch, scroll keys and pointer-down only mark recent input; the hold is released when the page
  // then really moves (>= USER_SCROLL_PX from the position it settled at after the jump). A late
  // layout shift with no input behind it does not release it, and a held section that disappears
  // does.
  orderRef.current = order;
  useEffect(() => scheduleRef.current(), [order]);

  useEffect(() => {
    let frame = 0;
    let settleTimer = 0;
    let retryTimer = 0;
    let retries = 0;
    let lastInputAt = -Infinity;
    let pointerDown = false;
    let held: { id: string; since: number; baseline: number | null; seen: boolean } | null = null;

    const settle = () => {
      if (held) held.baseline = window.scrollY;
    };
    const release = () => {
      held = null;
      hashHold.current = null;
      window.clearTimeout(settleTimer);
      window.clearTimeout(retryTimer);
    };
    const compute = () => {
      frame = 0;
      if (held) {
        const present = document.getElementById(held.id) !== null;
        if (present && !held.seen) {
          held.seen = true;
          measurePresent();
        } else if (!present && held.seen) {
          release();
        } else if (!present && retries++ < LATE_TARGET_TRIES) {
          window.clearTimeout(retryTimer);
          retryTimer = window.setTimeout(schedule, LATE_TARGET_RETRY_MS);
        } else if (!present) {
          release();
          measurePresent();
        }
        if (held) return;
      }
      const next = readActive(orderRef.current) ?? orderRef.current[0] ?? null;
      if (next) setActive(next);
    };
    function schedule() {
      if (!frame) frame = window.requestAnimationFrame(compute);
    }
    scheduleRef.current = schedule;
    const hold = (id: string) => {
      held = { id, since: Date.now(), baseline: null, seen: document.getElementById(id) !== null };
      retries = 0;
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(settle, SETTLE_MS);
    };
    holdRef.current = hold;

    const onScroll = () => {
      if (held) {
        if (held.baseline === null) {
          window.clearTimeout(settleTimer);
          settleTimer = window.setTimeout(settle, SETTLE_MS);
        } else if (
          Math.abs(window.scrollY - held.baseline) >= USER_SCROLL_PX &&
          (pointerDown || Date.now() - lastInputAt < RECENT_INPUT_MS)
        ) {
          release();
        }
      }
      schedule();
    };
    const markInput = () => {
      // Momentum from a gesture that began before the click is not the user moving on.
      if (held && Date.now() - held.since < SETTLE_MS) return;
      lastInputAt = Date.now();
    };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (!SCROLL_KEYS.has(e.key) || t?.closest?.(INTERACTIVE)) return;
      markInput();
    };
    const onPointerDown = () => {
      pointerDown = true;
    };
    const onPointerUp = () => {
      pointerDown = false;
    };
    const onScrollEnd = () => {
      window.clearTimeout(settleTimer);
      if (held && held.baseline === null) settle();
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('scrollend', onScrollEnd);
    window.addEventListener('wheel', markInput, { passive: true });
    window.addEventListener('touchmove', markInput, { passive: true });
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerUp, true);
    if (hashHold.current) hold(hashHold.current);
    schedule();
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scrollend', onScrollEnd);
      window.removeEventListener('wheel', markInput);
      window.removeEventListener('touchmove', markInput);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onPointerUp, true);
      window.cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
      window.clearTimeout(retryTimer);
      scheduleRef.current = () => {};
      holdRef.current = () => {};
    };
  }, [measurePresent]);

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
            className="absolute inset-x-0 top-full mt-1 max-h-[calc(100dvh-5rem)] overflow-y-auto overscroll-contain rounded-md border bg-card p-2 shadow-lg"
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
