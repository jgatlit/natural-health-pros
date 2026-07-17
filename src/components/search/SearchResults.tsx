'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useInfiniteHits, useInstantSearch, useStats } from 'react-instantsearch';
import { Skeleton } from '@/components/ui/skeleton';
import { PractitionerHitCard, type PractitionerHit } from './PractitionerHit';

/**
 * Track whether at least one real search response has landed.
 *
 * Previous attempt used results.__isArtificial — that flag never cleared in
 * react-instantsearch@7 + react-instantsearch-nextjs, leaving the skeleton on
 * forever. This implementation watches useInstantSearch().status: the moment
 * it transitions to 'loading' OR back to 'idle' with nbHits > 0, we know a
 * search ran. A 250 ms timeout fallback ensures we never gate the empty
 * state forever even if the search engine is silent for some reason.
 */
function useFirstResponseSeen(): boolean {
  const [seen, setSeen] = useState(false);
  const seenRef = useRef(false);
  const { status, results } = useInstantSearch();
  const { nbHits } = useStats();

  useEffect(() => {
    if (seenRef.current) return;
    // Any of these signals means InstantSearch is actively fetching or has data.
    const responded =
      status === 'loading' ||
      status === 'stalled' ||
      nbHits > 0 ||
      (results && (results as { processingTimeMS?: number }).processingTimeMS !== undefined);
    if (responded) {
      seenRef.current = true;
      setSeen(true);
    }
  }, [status, nbHits, results]);

  // Safety net: regardless of what InstantSearch reports, lift the gate after
  // 250 ms so we never trap users in the loading state.
  useEffect(() => {
    const t = setTimeout(() => {
      if (!seenRef.current) {
        seenRef.current = true;
        setSeen(true);
      }
    }, 250);
    return () => clearTimeout(t);
  }, []);

  return seen;
}

export function ResultStats() {
  const { nbHits } = useStats();
  const seen = useFirstResponseSeen();
  if (!seen) {
    return <Skeleton className="h-4 w-24" />;
  }
  return (
    <p className="text-xs font-medium text-muted-foreground" aria-live="polite">
      {nbHits === 1 ? '1 practitioner' : `${nbHits} practitioners`}
    </p>
  );
}

/**
 * useInfiniteHits, not useHits: useHits only ever exposes the CURRENT page, and there was no
 * pagination widget anywhere on /search — so with Typesense's default per_page of 10, hits 11+
 * were unreachable, not merely unshown. The directory reported "14 practitioners" and
 * "Virtual Practice 13" above a list of 10.
 *
 * Infinite (auto-load on scroll) rather than numbered pages: this is a directory people browse,
 * not a result set they navigate. `items` accumulates across pages; it resets on every new
 * refinement because `cache` is left off, which is what we want — filtering must never show
 * stale hits from the previous query.
 */
export function SearchResults() {
  const { items, isLastPage, showMore } = useInfiniteHits<PractitionerHit>();
  const { status } = useInstantSearch();
  const seen = useFirstResponseSeen();
  const refreshing = status === 'loading' || status === 'stalled';

  // STATE, not a ref — this is load-bearing and the first cut got it wrong.
  //
  // A ref does not notify anyone when its node attaches. This component early-returns a
  // skeleton until `seen` flips, so on mount the sentinel does not exist: an effect keyed to
  // [isLastPage] read `null`, bailed, and — since isLastPage never changed — never ran again.
  // The observer was therefore never created, and infinite scroll silently did nothing while
  // the Load more button (which calls showMore directly) worked fine, so it looked healthy.
  // A callback ref stored in state re-renders when the node mounts, which re-runs the effect.
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);

  // showMore's identity changes on every render; keeping it in a ref stops the observer being
  // torn down and rebuilt constantly while still always calling the current one.
  const showMoreRef = useRef(showMore);
  showMoreRef.current = showMore;

  const loadMore = useCallback(() => showMoreRef.current(), []);

  // items.length in the deps is REQUIRED, and this is the second bug this effect had.
  // IntersectionObserver only reports TRANSITIONS. After a page loads, the sentinel is pushed
  // down but usually stays inside the 400px margin — it never stops intersecting, so no
  // further callback ever fires and loading stalls one page in. Scrolling cannot rescue it;
  // the sentinel never left. Re-creating the observer on each load re-evaluates intersection
  // immediately, which fires again if the sentinel is still in view. That chains until the
  // viewport is full or isLastPage goes true — the guard above is what terminates it.
  useEffect(() => {
    if (!sentinel || isLastPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) showMoreRef.current();
      },
      // Fire before the sentinel is actually on screen so the next page is usually already
      // there by the time the user reaches the end.
      { rootMargin: '400px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinel, isLastPage, items.length]);

  if (!seen) {
    return <SearchResultsSkeleton />;
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-card p-8 text-center">
        <p className="text-sm font-medium">No practitioners match these filters.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Try clearing a filter or broadening your search.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ul
        className="grid grid-cols-1 gap-3 md:grid-cols-2"
        // Subtle dim while a refinement request is in flight so the user sees
        // that filtering is responding even before counts settle.
        style={refreshing ? { opacity: 0.7, transition: 'opacity 120ms ease' } : undefined}
      >
        {items.map((hit) => (
          <li key={hit.id}>
            <PractitionerHitCard hit={hit} />
          </li>
        ))}
      </ul>

      {!isLastPage && (
        // Both the scroll sentinel AND a real button: the observer covers mouse/touch
        // scrolling, the button covers keyboard and screen-reader users, who never
        // "scroll to" anything and would otherwise have no way to reach the rest.
        <div ref={setSentinel} className="flex justify-center pt-2">
          <button
            type="button"
            onClick={loadMore}
            className="rounded-md border px-4 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
          >
            Load more practitioners
          </button>
        </div>
      )}
    </div>
  );
}

function SearchResultsSkeleton() {
  return (
    <ul
      className="grid grid-cols-1 gap-3 md:grid-cols-2"
      aria-busy
      aria-label="Loading practitioners"
    >
      {Array.from({ length: 6 }).map((_, i) => (
        <li key={i}>
          <Skeleton className="h-28 w-full rounded-lg" />
        </li>
      ))}
    </ul>
  );
}
