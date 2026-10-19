// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { OfferingFields } from '@/components/practitioners/OfferingFields';
import { WHOP_OVER_LIMIT_MESSAGE } from '@/lib/whop-limits';

// tsk_eb9ee4d9 item 2(a): the offering editor says so while the practitioner types, and Save is
// blocked, before anything reaches the server (which refuses it again) or Whop.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLFormElement;

beforeEach(() => {
  host = document.createElement('form');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<OfferingFields offering={null} idPrefix="new" bookingLinks={[]} whopConnected />));
  // The title is required too; fill it so validity reflects the price alone.
  host.querySelector<HTMLInputElement>('input[name="title"]')!.value = 'Program';
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const price = () => host.querySelector<HTMLInputElement>('input[name="price"]')!;

function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(price(), value);
    price().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('offering price over $2,500', () => {
  it('shows the message and blocks Save; back under the limit clears both', () => {
    type('3000');
    expect(host.textContent).toContain(WHOP_OVER_LIMIT_MESSAGE);
    expect(host.checkValidity()).toBe(false);
    type('2500');
    expect(host.textContent).not.toContain(WHOP_OVER_LIMIT_MESSAGE);
    expect(host.checkValidity()).toBe(true);
  });

  it('reads "$2,600.00" the way the server does', () => {
    type('$2,600.00');
    expect(host.checkValidity()).toBe(false);
  });

  it('a free consultation is never blocked by it', () => {
    type('3000');
    const consult = host.querySelector<HTMLInputElement>('input[name="isConsult"]')!;
    act(() => consult.click());
    expect(host.textContent).not.toContain(WHOP_OVER_LIMIT_MESSAGE);
    expect(host.checkValidity()).toBe(true);
  });
});
