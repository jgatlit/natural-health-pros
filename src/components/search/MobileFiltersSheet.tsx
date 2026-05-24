'use client';

import { SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { useCurrentRefinements } from 'react-instantsearch';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { RefinementGroup } from './RefinementGroup';
import { RangeFacet } from './RangeFacet';

export function MobileFiltersSheet() {
  const [open, setOpen] = useState(false);
  const { items } = useCurrentRefinements();
  const activeCount = items.reduce((sum, scope) => sum + scope.refinements.length, 0);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-card px-3 text-xs font-medium shadow-sm transition-colors hover:bg-accent md:hidden">
        <SlidersHorizontal className="h-4 w-4" />
        Filters
        {activeCount > 0 && (
          <span className="ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
            {activeCount}
          </span>
        )}
      </SheetTrigger>
      <SheetContent side="bottom" className="flex h-[85vh] flex-col">
        <SheetHeader className="text-left">
          <SheetTitle>Filters</SheetTitle>
        </SheetHeader>
        <div className="flex-1 space-y-6 overflow-y-auto py-2">
          <RefinementGroup attribute="specialtyNames" title="Specialty" operator="or" />
          <RefinementGroup attribute="cityName" title="City" operator="and" />
          <RefinementGroup attribute="cityState" title="State" operator="and" />
          <RangeFacet attribute="yearsInPractice" title="Years in practice" unit="yr" />
        </div>
        <SheetFooter>
          <SheetClose className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90">
            Show results
          </SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
