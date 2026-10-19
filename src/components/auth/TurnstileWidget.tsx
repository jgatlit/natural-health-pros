'use client';

import Script from 'next/script';
import { useCallback, useEffect, useRef } from 'react';

type Turnstile = {
  render: (el: HTMLElement, opts: { sitekey: string }) => string | undefined;
  remove: (id: string) => void;
};

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

/**
 * Explicit rendering, because the implicit mode only scans the page once when the script loads and
 * misses a form reached by client-side navigation. The widget writes `cf-turnstile-response` into
 * the enclosing form.
 */
export function TurnstileWidget({ siteKey }: { siteKey: string }) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);

  const render = useCallback(() => {
    if (!window.turnstile || !container.current || widgetId.current) return;
    widgetId.current = window.turnstile.render(container.current, { sitekey: siteKey }) ?? null;
  }, [siteKey]);

  useEffect(() => {
    render();
    return () => {
      if (widgetId.current) window.turnstile?.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [render]);

  return (
    <>
      <Script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
        strategy="afterInteractive"
        onReady={render}
      />
      <div ref={container} className="flex justify-center" />
    </>
  );
}
