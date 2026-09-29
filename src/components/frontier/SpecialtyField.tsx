'use client';

/*
 * The specialty field — a force-directed graph whose NODES ARE THE WORDS.
 *
 * Replaces SpecialtyConstellation (WebGL spheres + a parallel text index beside it). Two things
 * were wrong with that, and this fixes both:
 *
 *   1. NO LABELS IN THE FRAME. The canvas showed unlabelled spheres, so a second list had to sit
 *      next to it carrying the actual names and the actual links. Two implementations of one
 *      feature, kept in sync by hand. Here the name IS the node, so there is nothing to mirror.
 *   2. THE ENCODING CARRIED NO INFORMATION. Its caption promised "node size is how many
 *      practitioners hold that specialty" — but measured on what this page actually renders
 *      (LISTED practitioners only): 21 specialties, of which 13 are held by exactly one and 5 by
 *      two. For most of the field every sphere was the same size. Size still varies here but is
 *      no longer doing the work: POSITION (real parent taxonomy — 5 clusters) and ADJACENCY
 *      (60 co-occurrence edges) are, and neither is something a flat list can show at all.
 *
 * ⚠️ HOVERING THE HUB LOOKS LIKE NOTHING HAPPENS, and that is truthful rather than broken.
 * "Holistic Health Coaching" (13) co-occurs with all 20 other specialties, so nothing dims. The
 * feedback is still there — the canvas drops from 60 lines to that node's 20 — but if this is
 * ever reported as a bug, it is the DATA saying that specialty connects to everything.
 *
 * WHY NOT force-graph / 3d-force-graph / PIXI, which are the mature options: at 29 nodes and ~112
 * edges the simulation is trivial, and rendering labels as DOM keeps real fonts, real anchors,
 * text selection and keyboard focus. Those libraries rasterise text into a canvas and lose all
 * four. Canvas here draws only the lines, so there is no WebGL and no new dependency.
 *
 * ⚠️ THIS DOES NOT MAKE THE PAGE LIGHTER, and an earlier draft of this comment claimed it did.
 * Measured: the homepage went 189 kB -> 191 kB first-load JS. Two reasons, both intended:
 * `three.js` is still downloaded because PracticeField (the hero ambience) still uses it — this
 * removed one of its two consumers, not the library — and this component is deliberately NOT
 * behind a `ssr: false` dynamic boundary the way the constellation was, so its weight counts
 * against the route instead of hiding in a lazy chunk. The 2 kB buys server-rendered, crawlable
 * specialty links. Removing three.js entirely is a separate decision about PracticeField.
 *
 * ⚠️ THE CURSOR DOES NOT CHASE-AND-FLEE ANY MORE. It used to repel every word within 150px, so the
 * word you were reaching for ran away as you approached. Now the word the pointer is heading for is
 * LOCKED (it stops), and the words around it make room for IT, not for the pointer. See
 * src/lib/specialty-field-lock.ts for the rule and its hysteresis. A word also has a hit area a few
 * pixels larger than its text, and a click just off a locked word still goes to it.
 *
 * D4: prefers-reduced-motion → the simulation is stepped to a settled layout once and never
 *     animated, cursor reactivity is off, and hover still works. Nothing is lost but the motion.
 * D7: there is no WebGL context to lose, so the old failure overlay has no analogue. The static
 *     fallback below is what renders if layout has not run yet, which also makes the field
 *     server-renderable and crawlable.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DirectorySpecialty } from '@/lib/directory';
import type { SpecialtyLink } from '@/lib/specialty-graph';
import { searchUrl } from '@/lib/search-url';
import { boxDistance, pickLockTarget } from '@/lib/specialty-field-lock';
import { useReducedMotion } from '@/lib/use-reduced-motion';
import { cn } from '@/lib/utils';

type Props = {
  specialties: DirectorySpecialty[];
  links: SpecialtyLink[];
};

type Node = {
  /** Index of the cluster anchor this node is pulled toward; -1 for a specialty with no parent. */
  cluster: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
};

/** Tier from the natural breaks in the real distribution (13 · 6-4 · 2 · 1). */
function tierClass(count: number): string {
  if (count >= 10) return 'font-serif text-[1.65rem] font-semibold text-ink';
  if (count >= 3) return 'font-serif text-[1.22rem] font-medium';
  if (count >= 2) return 'text-base';
  return 'text-sm font-normal';
}

export function SpecialtyField({ specialties, links }: Props) {
  const reduced = useReducedMotion();
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodeEls = useRef<(HTMLAnchorElement | null)[]>([]);
  const [hot, setHot] = useState<number | null>(null);
  /**
   * Nodes are absolutely positioned and only get real coordinates once layout has measured them.
   * Server-rendered HTML therefore contains every specialty anchor — crawlable, and the reason
   * this does NOT need `ssr: false` the way the WebGL constellation did — but all 29 would stack
   * at the origin for one frame. Held invisible (not unmounted) until the first paint places them.
   */
  const [placed, setPlaced] = useState(false);
  const hotRef = useRef<number | null>(null);
  hotRef.current = hot;

  /** Cluster anchors are the PARENT specialties actually present in this data. */
  const parents = useMemo(() => {
    const seen: string[] = [];
    for (const s of specialties) if (s.parent && !seen.includes(s.parent)) seen.push(s.parent);
    return seen;
  }, [specialties]);

  const bySlug = useMemo(
    () => new Map(specialties.map((s, i) => [s.slug, i])),
    [specialties],
  );

  /** Links resolved to indices once. A link naming a filtered-out slug is dropped, not crashed. */
  const edges = useMemo(
    () =>
      links
        .map((l) => ({ a: bySlug.get(l.a), b: bySlug.get(l.b), w: l.weight }))
        .filter((l): l is { a: number; b: number; w: number } => l.a != null && l.b != null),
    [links, bySlug],
  );

  const neighbours = useMemo(() => {
    const m = specialties.map(() => new Set<number>());
    for (const e of edges) {
      m[e.a].add(e.b);
      m[e.b].add(e.a);
    }
    return m;
  }, [edges, specialties]);

  const nodes = useRef<Node[]>([]);
  if (nodes.current.length !== specialties.length) {
    nodes.current = specialties.map((spec) => ({
      cluster: spec.parent
        ? parents.indexOf(spec.parent)
        : parents.indexOf(spec.name), // a parent clusters at its own anchor
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      w: 0,
      h: 0,
    }));
  }

  const run = useCallback(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const N = nodes.current;
    let W = 0;
    let H = 0;
    let centers: { x: number; y: number }[] = [];
    let alpha = 1;
    const pointer = { x: -1e5, y: -1e5, on: false };
    let dragging: Node | null = null;
    let raf = 0;
    /** Index of the word the pointer is heading for, or -1. Frozen in place while set. */
    let locked = -1;
    let dragStart: { x: number; y: number; i: number } | null = null;
    let didDrag = false;

    function measure() {
      const r = stage!.getBoundingClientRect();
      W = r.width;
      H = r.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas!.width = W * dpr;
      canvas!.height = H * dpr;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      N.forEach((n, i) => {
        const el = nodeEls.current[i];
        if (!el) return;
        n.w = el.offsetWidth;
        n.h = el.offsetHeight;
      });
      const radius = Math.min(W, H);
      centers = parents.map((_, k) => {
        const a = (k / Math.max(parents.length, 1)) * Math.PI * 2 - Math.PI / 2;
        return { x: W / 2 + Math.cos(a) * radius * 0.26, y: H / 2 + Math.sin(a) * radius * 0.24 };
      });
      N.forEach((n, i) => {
        if (n.x !== 0 || n.y !== 0) return;
        const c = n.cluster >= 0 ? centers[n.cluster] : { x: W / 2, y: H / 2 };
        const a = (i / N.length) * Math.PI * 2;
        n.x = c.x + Math.cos(a) * 40 + (i % 7) * 3;
        n.y = c.y + Math.sin(a) * 40 + (i % 5) * 3;
      });
    }

    function step() {
      for (const e of edges) {
        const a = N[e.a];
        const b = N[e.b];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        const f = ((d - (92 + 26 / e.w)) / d) * 0.0016 * e.w * alpha;
        dx *= f;
        dy *= f;
        a.vx += dx;
        a.vy += dy;
        b.vx -= dx;
        b.vy -= dy;
      }
      for (let i = 0; i < N.length; i++) {
        const n = N[i];
        const c = n.cluster >= 0 ? centers[n.cluster] : { x: W / 2, y: H / 2 };
        // Floored, NOT scaled to zero with alpha: words displaced to make room for a locked word
        // must be able to come home once it is released, however long the field has been at rest.
        const home = Math.max(alpha, 0.22) * 0.0042;
        n.vx += (c.x - n.x) * home;
        n.vy += (c.y - n.y) * home;
        for (let j = i + 1; j < N.length; j++) {
          const m = N[j];
          const dx = m.x - n.x;
          const dy = m.y - n.y;
          const d2 = dx * dx + dy * dy || 1;
          const d = Math.sqrt(d2);
          const rep = 340 / d2;
          n.vx -= (dx / d) * rep;
          n.vy -= (dy / d) * rep;
          m.vx += (dx / d) * rep;
          m.vy += (dy / d) * rep;
          // Rectangle overlap resolve — words must never sit on top of words. Around the LOCKED
          // word the clearance is larger and the shove is stronger, so its neighbours make room for
          // it; the locked word itself is frozen at integration and never gives way.
          const lk = i === locked || j === locked;
          const ox = (n.w + m.w) / 2 + 10 + (lk ? 16 : 0) - Math.abs(dx);
          const oy = (n.h + m.h) / 2 + 4 + (lk ? 10 : 0) - Math.abs(dy);
          if (ox > 0 && oy > 0) {
            const gain = lk ? 0.42 : 0.22;
            if (ox < oy) {
              const s = (dx < 0 ? -1 : 1) * ox * gain;
              n.vx -= s;
              m.vx += s;
            } else {
              const s = (dy < 0 ? -1 : 1) * oy * gain;
              n.vy -= s;
              m.vy += s;
            }
          }
        }
      }
      for (let i = 0; i < N.length; i++) {
        const n = N[i];
        if (n === dragging || i === locked) {
          n.vx = 0;
          n.vy = 0;
          continue;
        }
        n.vx *= 0.86;
        n.vy *= 0.86;
        n.x += n.vx;
        n.y += n.vy;
        const px = n.w / 2 + 6;
        const py = n.h / 2 + 4;
        n.x = Math.max(px, Math.min(W - px, n.x));
        n.y = Math.max(py, Math.min(H - py, n.y));
      }
      // Decay to REST. An earlier version floored alpha at 0.16, so the field drifted forever:
      // pretty, but it meant a practitioner was always clicking a moving target, and the rAF loop
      // never idled. Cursor movement re-heats it below, so the tactile response survives.
      alpha *= 0.994;
      if (alpha < 0.0008) alpha = 0;
    }

    const style = getComputedStyle(document.documentElement);
    function paint() {
      ctx!.clearRect(0, 0, W, H);
      const active = hotRef.current;
      const cool = style.getPropertyValue('--specialty-link').trim() || '#c3d2e2';
      const warm = style.getPropertyValue('--cta').trim() || '#c4396e';
      for (const e of edges) {
        const live = active != null && (e.a === active || e.b === active);
        if (active != null && !live) continue;
        ctx!.strokeStyle = live ? warm : cool;
        ctx!.globalAlpha = live ? 0.5 : 0.32;
        ctx!.lineWidth = live ? Math.min(1 + e.w * 0.5, 3) : 0.7;
        ctx!.beginPath();
        ctx!.moveTo(N[e.a].x, N[e.a].y);
        ctx!.lineTo(N[e.b].x, N[e.b].y);
        ctx!.stroke();
      }
      ctx!.globalAlpha = 1;
      N.forEach((n, i) => {
        const el = nodeEls.current[i];
        if (el) el.style.transform = `translate(${n.x - n.w / 2}px, ${n.y - n.h / 2}px)`;
      });
    }

    measure();
    const reveal = () => setPlaced(true);

    if (reduced) {
      // Settle once, paint once, never animate. Hover still works because it is CSS + React.
      for (let k = 0; k < 320; k++) step();
      paint();
      reveal();
      const onResize = () => {
        measure();
        for (let k = 0; k < 200; k++) step();
        paint();
      };
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }

    for (let k = 0; k < 90; k++) step();
    // At rest only when the field has cooled AND nobody is mid-drag. A locked word does not keep
    // the loop alive: it is frozen, so there is nothing left to simulate.
    const settled = () => alpha === 0 && !dragging;
    const loop = () => {
      // Skip the work entirely once the layout is at rest. The frame still fires so interaction
      // resumes instantly, but nothing is simulated or drawn.
      if (!settled()) {
        step();
        paint();
        reveal();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const onResize = () => {
      measure();
      alpha = 0.7;
    };

    const setLock = (next: number) => {
      if (next === locked) return;
      locked = next;
      // A light nudge, not a re-heat of the whole field: only the neighbours of the locked word
      // need to move, and only by a little.
      alpha = Math.max(alpha, 0.16);
    };

    const onMove = (e: PointerEvent) => {
      // Touch has no hover, so there is nothing to lock — and a touch drag is a page scroll.
      if (e.pointerType === 'touch') return;
      const r = stage!.getBoundingClientRect();
      pointer.x = e.clientX - r.left;
      pointer.y = e.clientY - r.top;
      pointer.on = true;

      // A drag starts only once the pointer has actually travelled: a plain click must never
      // move the word it lands on, and must never be swallowed as a drag.
      if (dragStart && !dragging && Math.hypot(pointer.x - dragStart.x, pointer.y - dragStart.y) > 6) {
        dragging = N[dragStart.i];
        didDrag = true;
      }
      if (dragging) {
        dragging.x = pointer.x;
        dragging.y = pointer.y;
        dragging.vx = 0;
        dragging.vy = 0;
        alpha = Math.max(alpha, 0.5);
        setLock(N.indexOf(dragging));
        return;
      }
      setLock(pickLockTarget(N, pointer, locked));
    };
    const onLeave = () => {
      pointer.on = false;
      pointer.x = -1e5;
      pointer.y = -1e5;
      if (!dragging) setLock(-1);
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const target = (e.target as HTMLElement | null)?.closest('a');
      if (!target) return;
      const i = nodeEls.current.indexOf(target as HTMLAnchorElement);
      if (i < 0) return;
      const r = stage!.getBoundingClientRect();
      dragStart = { x: e.clientX - r.left, y: e.clientY - r.top, i };
      didDrag = false;
    };
    const onUp = () => {
      dragging = null;
      dragStart = null;
      // Keep the flag through the click that follows pointerup, then clear it.
      setTimeout(() => {
        didDrag = false;
      }, 0);
      if (!pointer.on) setLock(-1);
    };
    /**
     * Two click jobs. (1) A drag ends in a click on the same anchor — swallow it, or letting go of
     * a word you were repositioning would navigate away. (2) A click that lands in the gap just
     * beside a locked word still goes to it: the target that is highlighted is the target you get.
     */
    const onClick = (e: MouseEvent) => {
      if (didDrag) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if ((e.target as HTMLElement | null)?.closest('a')) return;
      if (locked < 0) return;
      const r = stage!.getBoundingClientRect();
      const d = boxDistance(N[locked], e.clientX - r.left, e.clientY - r.top);
      if (d <= 24) nodeEls.current[locked]?.click();
    };

    window.addEventListener('resize', onResize);
    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerleave', onLeave);
    stage.addEventListener('pointerdown', onDown);
    stage.addEventListener('click', onClick, true);
    window.addEventListener('pointerup', onUp);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      stage.removeEventListener('pointermove', onMove);
      stage.removeEventListener('pointerleave', onLeave);
      stage.removeEventListener('pointerdown', onDown);
      stage.removeEventListener('click', onClick, true);
      window.removeEventListener('pointerup', onUp);
    };
  }, [edges, parents, reduced]);

  useEffect(() => run(), [run]);

  return (
    <div>
      <div
        ref={stageRef}
        className="relative h-[460px] w-full touch-pan-y overflow-hidden rounded-xl border border-border bg-secondary/40 sm:h-[560px]"
        style={{ ['--specialty-link' as string]: 'color-mix(in oklch, var(--primary) 28%, transparent)' }}
      >
        <canvas ref={canvasRef} aria-hidden className="absolute inset-0 h-full w-full" />
        {specialties.map((s, i) => (
          <a
            key={s.slug}
            ref={(el) => {
              nodeEls.current[i] = el;
            }}
            href={searchUrl({ specialtyName: s.name })}
            aria-label={`${s.name} — ${s.count} practitioner${s.count === 1 ? '' : 's'}`}
            onPointerEnter={() => setHot(i)}
            onPointerLeave={() => setHot((h) => (h === i ? null : h))}
            onFocus={() => setHot(i)}
            onBlur={() => setHot((h) => (h === i ? null : h))}
            className={cn(
              'absolute left-0 top-0 select-none whitespace-nowrap rounded-md px-1.5 py-0.5 text-primary no-underline',
              // Hit area a few px larger than the text, so a near miss is still a hit.
              "after:absolute after:-inset-2 after:content-['']",
              'transition-[color,opacity,background-color] duration-150',
              'hover:bg-background hover:text-cta focus-visible:bg-background focus-visible:text-cta',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cta',
              tierClass(s.count),
              !placed && 'invisible',
              hot != null && hot !== i && !neighbours[hot]?.has(i) && 'opacity-20',
              hot != null && neighbours[hot]?.has(i) && 'text-secondary-foreground',
            )}
          >
            {s.name}
            <span className="ml-1.5 text-[0.68em] tabular-nums text-muted-foreground">
              {s.count}
            </span>
          </a>
        ))}
      </div>

      <p className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <span>
          <strong className="font-medium text-foreground">Position</strong> — pulled toward its
          parent specialty
        </span>
        <span>
          <strong className="font-medium text-foreground">Line</strong> — a practitioner holds both
        </span>
        <span>
          <strong className="font-medium text-foreground">Size</strong> — practitioners holding it
        </span>
      </p>
    </div>
  );
}
