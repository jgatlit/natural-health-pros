'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Card } from '@/components/ui/card';

/** The practitioner's own recruiting link. Deliberately small: no earnings, just the URL. */
export function JoinLinkCard({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked; the URL stays visible and selectable.
    }
  }

  return (
    <Card id="share-signup" className="scroll-mt-24 space-y-2 p-4 sm:p-5">
      <h2 className="text-sm font-semibold">Invite another practitioner</h2>
      <p className="text-xs text-muted-foreground">
        Bring the natural health and wellness practitioners you trust onto Natural Health Pros.
      </p>
      <div className="flex items-center gap-2">
        <input
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Your sign-up link"
          className="h-9 min-w-0 flex-1 rounded-md border bg-card px-2 text-xs"
        />
        <button
          type="button"
          onClick={copy}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-xs font-medium hover:bg-muted"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </Card>
  );
}
