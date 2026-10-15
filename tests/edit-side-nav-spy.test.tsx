// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { StrictMode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EditSideNav, type EditSideNavEntry } from '@/components/practitioners/EditSideNav';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENTRIES: EditSideNavEntry[] = [
  {
    id: 'profile',
    label: 'Profile',
    children: [
      { id: 'profile-photo', label: 'Photo' },
      { id: 'profile-qualifications', label: 'Qualifications' },
      { id: 'profile-extra-work', label: 'Open to outside work' },
    ],
  },
  { id: 'client-outcomes', label: 'Client outcomes' },
  { id: 'sections', label: 'Custom sections' },
  { id: 'share-signup', label: 'Invite another practitioner' },
  { id: 'account', label: 'Account email' },
];
const IDS = ['profile', 'profile-photo', 'profile-qualifications', 'profile-extra-work', 'client-outcomes', 'sections', 'share-signup', 'account'];
// Page-coordinate tops; the viewport top is scrollY.
const PAGE_TOPS: Record<string, number> = {
  profile: 0,
  'profile-photo': 200,
  'profile-qualifications': 900,
  'profile-extra-work': 1500,
  'client-outcomes': 1600,
  sections: 2400,
  'share-signup': 3000,
  account: 3200,
};
const DOC_HEIGHT = 3500;
const VIEWPORT = 800;

let scrollY = 0;
let root: Root;
let host: HTMLDivElement;

function buildPage(ids = IDS) {
  document.body.innerHTML = ids.map((id) => `<div id="${id}"><h2>${id}</h2></div>`).join('') + '<div id="host"></div>';
  host = document.getElementById('host') as HTMLDivElement;
  for (const id of ids) {
    document.getElementById(id)!.getBoundingClientRect = () => ({ top: PAGE_TOPS[id]! - scrollY }) as DOMRect;
  }
}
function mount(entries = ENTRIES) {
  root = createRoot(host);
  act(() => root.render(<EditSideNav entries={entries} />));
}
const scrollTo = (y: number) => {
  scrollY = y;
  act(() => {
    window.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(20);
  });
};
const userScrollTo = (y: number) => {
  act(() => {
    window.dispatchEvent(new Event('wheel'));
  });
  scrollTo(y);
};
const currentIds = () =>
  Array.from(document.querySelectorAll('[data-edit-nav="desktop"] [aria-current="location"]')).map((a) =>
    a.getAttribute('href'),
  );
const link = (id: string) => document.querySelector<HTMLAnchorElement>(`[data-edit-nav="desktop"] a[href="#${id}"]`)!;
const click = (el: Element) => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  scrollY = 0;
  window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    window.setTimeout(() => cb(0), 16)) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) => window.clearTimeout(id)) as typeof window.cancelAnimationFrame;
  window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia;
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT });
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
  Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, get: () => DOC_HEIGHT });
  Element.prototype.scrollIntoView = vi.fn();
  window.history.replaceState(null, '', '/practitioners/x/edit');
  buildPage();
});

afterEach(() => {
  act(() => root?.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('EditSideNav reading-line scroll-spy', () => {
  it('puts the last anchor above the reading line in aria-current and its parent in a quieter style', () => {
    mount();
    scrollTo(500);
    expect(currentIds()).toEqual(['#profile-photo']);
    const parent = link('profile');
    expect(parent.getAttribute('aria-current')).toBeNull();
    expect(parent.className).toContain('font-medium');
    expect(parent.className).not.toContain('bg-primary/10');
  });

  it('makes the last entry active at the very bottom of the page', () => {
    mount();
    scrollTo(DOC_HEIGHT - VIEWPORT);
    expect(currentIds()).toEqual(['#account']);
    scrollTo(DOC_HEIGHT - VIEWPORT - 1);
    expect(currentIds()).toEqual(['#account']);
    scrollTo(2500);
    expect(currentIds()).toEqual(['#sections']);
  });

  it('keeps one entry across gaps between children instead of alternating', () => {
    mount();
    const seen: string[] = [];
    for (let y = 0; y <= 1500; y += 25) {
      scrollTo(y);
      const ids = currentIds();
      expect(ids).toHaveLength(1);
      if (seen[seen.length - 1] !== ids[0]) seen.push(ids[0]!);
    }
    expect(seen).toEqual(['#profile', '#profile-photo', '#profile-qualifications', '#profile-extra-work']);
  });

  it('a click on a parent keeps the parent active until the user scrolls', () => {
    mount();
    scrollTo(1000);
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      scrollY = PAGE_TOPS[this.id]! - 96;
    });
    click(link('profile'));
    expect(currentIds()).toEqual(['#profile']);
    scrollTo(scrollY);
    expect(currentIds()).toEqual(['#profile']);
    act(() => {
      window.dispatchEvent(new Event('scrollend'));
    });
    wait(300);
    userScrollTo(PAGE_TOPS['profile-qualifications']! - 90);
    expect(currentIds()).toEqual(['#profile-qualifications']);
  });

  it.each(['profile-extra-work', 'share-signup', 'account'])('a click on %s holds that entry, even near the bottom', (id) => {
    mount();
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      scrollY = Math.min(PAGE_TOPS[this.id]! - 96, DOC_HEIGHT - VIEWPORT);
    });
    click(link(id));
    expect(currentIds()).toEqual([`#${id}`]);
    scrollTo(scrollY);
    expect(currentIds()).toEqual([`#${id}`]);
  });

  const MAX = DOC_HEIGHT - VIEWPORT;
  const clickShareSignup = () => {
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      scrollY = Math.min(PAGE_TOPS[this.id]! - 96, MAX);
    });
    click(link('share-signup'));
  };
  const wait = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });

  it('keeps an entry whose target cannot reach the line far past 700ms, until the user scrolls', () => {
    mount();
    clickShareSignup();
    expect(scrollY).toBe(MAX);
    expect(document.getElementById('share-signup')!.getBoundingClientRect().top).toBeGreaterThan(98);
    scrollTo(scrollY);
    wait(5000);
    scrollTo(scrollY);
    expect(currentIds()).toEqual(['#share-signup']);
    act(() => {
      window.dispatchEvent(new Event('scrollend'));
    });
    scrollTo(scrollY + 10);
    expect(currentIds()).toEqual(['#share-signup']);
    userScrollTo(MAX - 300);
    expect(currentIds()).toEqual(['#sections']);
    scrollTo(MAX);
    expect(currentIds()).toEqual(['#account']);
  });

  it.each(['wheel', 'touchmove'])('does not release on %s when the page does not move', (type) => {
    mount();
    clickShareSignup();
    wait(1000);
    act(() => {
      window.dispatchEvent(new Event(type));
    });
    wait(20);
    scrollTo(scrollY);
    expect(currentIds()).toEqual(['#share-signup']);
  });

  it.each(['wheel', 'touchmove'])('releases on %s that really moves the page', (type) => {
    mount();
    clickShareSignup();
    wait(1000);
    act(() => {
      window.dispatchEvent(new Event(type));
    });
    scrollTo(scrollY - 30);
    expect(currentIds()).toEqual(['#sections']);
  });

  it('ignores input right after a click (momentum), then honours it', () => {
    mount();
    clickShareSignup();
    act(() => {
      window.dispatchEvent(new Event('wheel'));
    });
    wait(1000);
    scrollTo(scrollY - 30);
    expect(currentIds()).toEqual(['#share-signup']);
  });

  it('releases on a scrollbar drag (pointer down plus movement) without any wheel', () => {
    mount();
    clickShareSignup();
    wait(1000);
    act(() => {
      window.dispatchEvent(new Event('pointerdown'));
    });
    wait(3000);
    scrollTo(scrollY - 200);
    expect(currentIds()).toEqual(['#sections']);
  });

  it('a late layout shift with no input does not release the hold', () => {
    mount();
    clickShareSignup();
    wait(1000);
    scrollTo(scrollY - 200);
    expect(currentIds()).toEqual(['#share-signup']);
  });

  it('a scroll key releases only when focus is not in an interactive control', () => {
    mount();
    clickShareSignup();
    wait(1000);
    const button = document.createElement('button');
    document.body.appendChild(button);
    act(() => {
      button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    scrollTo(scrollY - 30);
    expect(currentIds()).toEqual(['#share-signup']);
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
    });
    scrollTo(scrollY - 30);
    expect(currentIds()).toEqual(['#sections']);
  });

  it('clears the hold when the held section is removed', () => {
    mount();
    clickShareSignup();
    wait(1000);
    document.getElementById('share-signup')!.remove();
    scrollTo(scrollY);
    expect(currentIds()).toEqual(['#account']);
  });

  it.each(['share-signup', 'account'])('a hash load of #%s keeps its own entry at max scroll for 3s', (id) => {
    window.history.replaceState(null, '', `/practitioners/x/edit#${id}`);
    scrollY = MAX;
    mount();
    wait(3000);
    scrollTo(MAX);
    expect(currentIds()).toEqual([`#${id}`]);
    userScrollTo(MAX - 200);
    expect(currentIds()).not.toEqual([`#${id}`]);
  });

  it('a hash target that mounts AFTER the first effect run is still held', () => {
    window.history.replaceState(null, '', '/practitioners/x/edit#share-signup');
    scrollY = MAX;
    document.getElementById('share-signup')!.remove();
    mount();
    scrollTo(MAX);
    wait(1000);
    expect(currentIds()).toEqual(['#share-signup']);
    const late = document.createElement('div');
    late.id = 'share-signup';
    late.getBoundingClientRect = () => ({ top: PAGE_TOPS['share-signup']! - scrollY }) as DOMRect;
    document.body.insertBefore(late, document.getElementById('account'));
    wait(500);
    scrollTo(MAX);
    wait(3000);
    expect(currentIds()).toEqual(['#share-signup']);
    expect(link('share-signup')).not.toBeNull();
  });

  it('keeps the hash hold under StrictMode double mount', () => {
    window.history.replaceState(null, '', '/practitioners/x/edit#share-signup');
    scrollY = MAX;
    root = createRoot(host);
    act(() =>
      root.render(
        <StrictMode>
          <EditSideNav entries={ENTRIES} />
        </StrictMode>,
      ),
    );
    wait(3000);
    scrollTo(MAX);
    expect(currentIds()).toEqual(['#share-signup']);
  });

  it('never keeps a stale highlight above the first anchor', () => {
    mount();
    scrollTo(MAX);
    expect(currentIds()).toEqual(['#account']);
    PAGE_TOPS.profile = 300;
    try {
      scrollTo(0);
      expect(currentIds()).toEqual(['#profile']);
      scrollTo(50);
      expect(currentIds()).toEqual(['#profile']);
    } finally {
      PAGE_TOPS.profile = 0;
    }
  });

  it('bounds the open mobile menu to the viewport and contains its scroll', () => {
    mount();
    const cls = document.querySelector('[data-edit-nav="mobile"] nav')!.className;
    expect(cls).toContain('max-h-[calc(100dvh-5rem)]');
    expect(cls).toContain('overflow-y-auto');
    expect(cls).toContain('overscroll-contain');
  });

  it('re-reads the anchors when the entry list changes', () => {
    mount();
    scrollTo(2500);
    expect(currentIds()).toEqual(['#sections']);
    const withoutIds = IDS.filter((id) => id !== 'sections');
    const without = ENTRIES.filter((e) => e.id !== 'sections');
    document.getElementById('sections')!.remove();
    act(() => root.render(<EditSideNav entries={without} />));
    scrollTo(2501);
    expect(currentIds()).toEqual(['#client-outcomes']);
    expect(withoutIds).not.toContain('sections');
  });

  it('removes its listeners on unmount', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    mount();
    act(() => root.unmount());
    const types = remove.mock.calls.map(([t]) => t);
    expect(types).toEqual(expect.arrayContaining(['scroll', 'resize', 'scrollend', 'click']));
    root = createRoot(host);
  });

  it('mobile menu closes on Escape and on an outside click, but not on a click inside', () => {
    mount();
    const details = document.querySelector('details')!;
    details.open = true;
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(details.open).toBe(false);
    details.open = true;
    click(details.querySelector('nav')!);
    expect(details.open).toBe(true);
    click(document.body);
    expect(details.open).toBe(false);
  });

  it('does not render data-dependent entries before it has checked the page', () => {
    const html = renderToStaticMarkup(
      <EditSideNav entries={[{ id: 'profile', label: 'Profile' }, { id: 'brought-in', label: 'Brought in', deferred: true }]} />,
    );
    expect(html).toContain('href="#profile"');
    expect(html).not.toContain('href="#brought-in"');
  });
});
