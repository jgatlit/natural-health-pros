'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export type EditSideNavEntry = {
  id: string;
  label: string;
  children?: readonly EditSideNavEntry[];
};

function flatten(entries: readonly EditSideNavEntry[]): EditSideNavEntry[] {
  return entries.flatMap((e) => [e, ...(e.children ? flatten(e.children) : [])]);
}

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

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

  useEffect(() => {
    const found = new Set<string>();
    for (const e of flatten(entries)) if (document.getElementById(e.id)) found.add(e.id);
    setPresent(found);
    const fromHash = decodeURIComponent(window.location.hash.slice(1));
    if (fromHash && found.has(fromHash)) setActive(fromHash);
  }, [entries]);

  const visible = useMemo(() => {
    if (!present) return entries;
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
        if (detailsRef.current) detailsRef.current.open = false;
      }
    };
    window.addEventListener('click', onClick, true);
    return () => window.removeEventListener('click', onClick, true);
  }, []);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const inView = new Set<string>();
    const observer = new IntersectionObserver(
      (records) => {
        for (const r of records) {
          if (r.isIntersecting) inView.add(r.target.id);
          else inView.delete(r.target.id);
        }
        const current = [...order].reverse().find((id) => inView.has(id));
        if (current) setActive(current);
      },
      { rootMargin: '-15% 0px -75% 0px' },
    );
    for (const id of order) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [order]);

  useEffect(() => {
    const nav = desktopRef.current;
    if (!active || !nav || nav.scrollHeight <= nav.clientHeight) return;
    nav.querySelector('[aria-current="location"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const activeLabel = flatten(visible).find((e) => e.id === active)?.label ?? null;

  const linkClass = (id: string, nested: boolean) =>
    cn(
      'block rounded-md border-l-2 py-1.5 text-sm transition-colors hover:bg-muted hover:text-foreground',
      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
      nested ? 'pl-5 pr-2 text-xs' : 'pl-3 pr-2',
      active === id
        ? 'border-primary bg-primary/10 font-medium text-foreground'
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
