// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
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
    scrollTo(PAGE_TOPS['profile-qualifications']! - 90);
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

  it('releases the hold after the timeout when no scrollend arrives', () => {
    mount();
    click(link('profile-extra-work'));
    scrollTo(2500);
    expect(currentIds()).toEqual(['#profile-extra-work']);
    act(() => {
      vi.advanceTimersByTime(800);
    });
    scrollTo(2500);
    expect(currentIds()).toEqual(['#sections']);
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
