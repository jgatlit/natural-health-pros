import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

// Mirrors the two-column Variation-B profile layout so there's no layout shift
// when the server-rendered page swaps in (see page.tsx: max-w-4xl + 22rem rail).
export default function Loading() {
  return (
    <main className="min-h-screen bg-muted/30 px-4 py-10 sm:py-16">
      <div className="mx-auto max-w-4xl">
        <Card className="p-6 sm:p-12">
          <div className="grid gap-12 sm:grid-cols-[22rem_1fr]">
            {/* Identity + booking rail */}
            <aside className="min-w-0 space-y-6">
              <Skeleton className="aspect-[4/5] w-full rounded-xl" />
              <div className="space-y-3">
                <Skeleton className="h-7 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
                <div className="space-y-2 pt-1">
                  <Skeleton className="h-3.5 w-2/3" />
                  <Skeleton className="h-3.5 w-1/2" />
                </div>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <Skeleton className="h-6 w-24 rounded-full" />
                  <Skeleton className="h-6 w-20 rounded-full" />
                  <Skeleton className="h-6 w-28 rounded-full" />
                </div>
              </div>
              <Skeleton className="h-11 w-full rounded-md" />
            </aside>

            {/* Scrollable narrative */}
            <div className="min-w-0 space-y-6">
              <div className="space-y-2">
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-11/12" />
              </div>
              <div className="space-y-3 rounded-lg bg-secondary/40 p-5">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-5/6" />
                <Skeleton className="h-3.5 w-3/4" />
              </div>
              <div className="space-y-3 rounded-lg bg-secondary/40 p-5">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-2/3" />
              </div>
            </div>
          </div>
        </Card>
      </div>
    </main>
  );
}
