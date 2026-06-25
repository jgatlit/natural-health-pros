'use client';

import { Component, type ReactNode } from 'react';
import { useInstantSearch } from 'react-instantsearch';

/**
 * Shared fallback shown when the search backend (Typesense) is unreachable.
 *
 * Why this exists: when the cluster is down/slow, the InstantSearch SSR initial
 * search either throws during render or surfaces an error via state. Without a
 * boundary the page streams an HTTP 200 shell that hangs on a perpetual loading
 * skeleton (the silent outage of 2026-06-24). This degrades that into an honest,
 * actionable message instead.
 */
function UnavailableNotice() {
  return (
    <div
      className="rounded-lg border border-dashed bg-card p-8 text-center"
      role="alert"
    >
      <p className="text-sm font-medium">Search is temporarily unavailable.</p>
      <p className="mt-1 text-xs text-muted-foreground">
        We&rsquo;re having trouble reaching the directory index. Please try again in a moment.
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-4 inline-flex h-8 items-center rounded-md border bg-background px-3 text-xs font-medium hover:bg-muted"
      >
        Try again
      </button>
    </div>
  );
}

/**
 * Class error boundary — catches errors thrown during render (including the SSR
 * initial-search rejection that react-instantsearch-nextjs propagates). Function
 * components can't catch render errors, so this has to be a class.
 */
export class SearchErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="mx-auto max-w-md py-8">
          <UnavailableNotice />
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Inline guard for errors that InstantSearch surfaces via state rather than by
 * throwing (e.g. a runtime query failure after the tree has mounted). Renders the
 * children normally until an error appears, then swaps in the notice — so a mid-
 * session backend blip doesn't leave stale results or a stuck skeleton.
 */
export function SearchErrorState({ children }: { children: ReactNode }) {
  const { error } = useInstantSearch();
  if (error) {
    return <UnavailableNotice />;
  }
  return <>{children}</>;
}
