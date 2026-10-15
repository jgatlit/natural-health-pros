// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { EditSideNav, type EditSideNavEntry } from '@/components/practitioners/EditSideNav';
import { UnsavedChangesBar } from '@/components/practitioners/UnsavedChangesBar';

vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  useFormStatus: () => ({ pending: false }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENTRIES: EditSideNavEntry[] = [
  { id: 'profile', label: 'Profile', children: [{ id: 'profile-photo', label: 'Photo' }] },
  { id: 'offerings', label: 'Offerings' },
  { id: 'brought-in', label: 'Practitioners you brought in' },
];

let observers: { cb: IntersectionObserverCallback; observed: Element[] }[] = [];
let reduced = false;
let root: Root;
let host: HTMLDivElement;
const scrollSpy = vi.fn();

beforeEach(() => {
  observers = [];
  reduced = false;
  scrollSpy.mockReset();
  Element.prototype.scrollIntoView = scrollSpy;
  window.matchMedia = ((q: string) => ({ matches: reduced && q.includes('reduce'), media: q })) as typeof window.matchMedia;
  globalThis.IntersectionObserver = class {
    entry = { cb: null as unknown as IntersectionObserverCallback, observed: [] as Element[] };
    constructor(cb: IntersectionObserverCallback) {
      this.entry.cb = cb;
      observers.push(this.entry);
    }
    observe(el: Element) {
      this.entry.observed.push(el);
    }
    disconnect() {}
    unobserve() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
  document.body.innerHTML = `
    <form id="f"><div id="profile"><h1>Edit profile</h1><div id="profile-photo">Photo</div></div></form>
    <div id="offerings"><h2>Offerings</h2></div>
    <a id="elsewhere" href="/somewhere-else">Elsewhere</a>
    <div id="host"></div>`;
  host = document.getElementById('host') as HTMLDivElement;
  window.history.replaceState(null, '', '/practitioners/x/edit');
});

afterEach(() => {
  act(() => root?.unmount());
  vi.restoreAllMocks();
});

function mount(entries = ENTRIES, extra?: React.ReactNode) {
  root = createRoot(host);
  act(() => root.render(<>{extra}<EditSideNav entries={entries} /></>));
}

const desktopLink = (id: string) => document.querySelector<HTMLAnchorElement>(`[data-edit-nav="desktop"] a[href="#${id}"]`)!;
const click = (el: Element) => {
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  act(() => {
    el.dispatchEvent(ev);
  });
  return ev;
};

describe('EditSideNav', () => {
  it('renders a labelled nav of real links with a nested list', () => {
    mount();
    const nav = document.querySelector('[data-edit-nav="desktop"]')!;
    expect(nav.tagName).toBe('NAV');
    expect(nav.getAttribute('aria-label')).toBe('Edit sections');
    expect(nav.querySelectorAll('ul ul a')).toHaveLength(1);
    expect(desktopLink('offerings').getAttribute('href')).toBe('#offerings');
  });

  it('prunes entries whose anchor is not on the page', () => {
    mount();
    expect(desktopLink('brought-in')).toBeNull();
    expect(desktopLink('offerings')).not.toBeNull();
  });

  it('mobile control lists the same entries', () => {
    mount();
    const labels = (sel: string) =>
      Array.from(document.querySelectorAll(`${sel} a`)).map((a) => `${a.getAttribute('href')}|${a.textContent}`);
    expect(labels('[data-edit-nav="mobile"]')).toEqual(labels('[data-edit-nav="desktop"]'));
    expect(document.querySelector('[data-edit-nav="mobile"] summary')?.textContent).toContain('Jump to');
  });

  it('click scrolls smoothly, replaces the hash, focuses the heading and does not navigate', () => {
    mount();
    const replace = vi.spyOn(window.history, 'replaceState');
    const push = vi.spyOn(window.history, 'pushState');
    const ev = click(desktopLink('offerings'));
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    expect(replace).toHaveBeenCalledWith(window.history.state, '', '#offerings');
    expect(push).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#offerings');
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('#offerings h2'));
    expect(desktopLink('offerings').getAttribute('aria-current')).toBe('location');
  });

  it('is instant under prefers-reduced-motion', () => {
    reduced = true;
    mount();
    click(desktopLink('offerings'));
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
  });

  it('focuses the target itself when a sub-section has no heading', () => {
    mount();
    click(desktopLink('profile-photo'));
    expect(document.activeElement).toBe(document.getElementById('profile-photo'));
  });

  it('leaves modified clicks to the browser', () => {
    mount();
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
    act(() => {
      desktopLink('offerings').dispatchEvent(ev);
    });
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('marks the section in view via IntersectionObserver, preferring the deepest', () => {
    mount();
    const obs = observers.at(-1)!;
    const rec = (id: string, isIntersecting: boolean) =>
      ({ target: document.getElementById(id), isIntersecting }) as unknown as IntersectionObserverEntry;
    act(() => obs.cb([rec('profile', true)], {} as IntersectionObserver));
    expect(desktopLink('profile').getAttribute('aria-current')).toBe('location');
    act(() => obs.cb([rec('profile-photo', true)], {} as IntersectionObserver));
    expect(desktopLink('profile-photo').getAttribute('aria-current')).toBe('location');
    expect(desktopLink('profile').getAttribute('aria-current')).toBeNull();
    expect(document.querySelectorAll('[data-edit-nav="desktop"] [aria-current]')).toHaveLength(1);
  });

  it('scrolls the active item into view when the nav is taller than its box', () => {
    mount();
    const nav = document.querySelector('[data-edit-nav="desktop"]')!;
    Object.defineProperty(nav, 'scrollHeight', { configurable: true, value: 900 });
    Object.defineProperty(nav, 'clientHeight', { configurable: true, value: 300 });
    scrollSpy.mockClear();
    const obs = observers.at(-1)!;
    act(() =>
      obs.cb([{ target: document.getElementById('offerings'), isIntersecting: true } as unknown as IntersectionObserverEntry], {} as IntersectionObserver),
    );
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' });
  });
});

describe('EditSideNav and the unsaved-changes guard', () => {
  function mountWithGuard() {
    document.body.innerHTML = `
      <div id="profile"><h1>Edit profile</h1></div>
      <div id="offerings"><h2>Offerings</h2></div>
      <a id="elsewhere" href="/somewhere-else">Elsewhere</a>
      <div id="host"></div>`;
    host = document.getElementById('host') as HTMLDivElement;
    root = createRoot(host);
    act(() =>
      root.render(
        <>
          <form id="f">
            <input name="displayName" />
            <UnsavedChangesBar />
          </form>
          <EditSideNav entries={ENTRIES} />
        </>,
      ),
    );
  }

  it('a nav click on a dirty form raises no confirm and leaves the dirty flag alone', () => {
    mountWithGuard();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const input = document.querySelector('input')!;
    act(() => {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(document.body.textContent).toContain('Unsaved changes.');

    const ev = click(desktopLink('offerings'));

    expect(confirm).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
    expect(scrollSpy).toHaveBeenCalled();
    expect(document.body.textContent).toContain('Unsaved changes.');

    // positive control: the guard is live and still blocks a real navigation away
    const away = click(document.getElementById('elsewhere')!);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(away.defaultPrevented).toBe(true);
  });

  it('does not add a beforeunload listener or mark a clean form dirty', () => {
    mountWithGuard();
    const add = vi.spyOn(window, 'addEventListener');
    click(desktopLink('offerings'));
    expect(add.mock.calls.filter(([t]) => t === 'beforeunload')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('Unsaved changes.');
  });
});
