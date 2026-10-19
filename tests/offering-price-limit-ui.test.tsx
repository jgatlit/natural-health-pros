// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { OfferingFields } from '@/components/practitioners/OfferingFields';
import { WHOP_OVER_LIMIT_MESSAGE } from '@/lib/whop-limits';

// tsk_eb9ee4d9 item 2(a): the offering editor says so while the practitioner types, and Save is
// blocked, before anything reaches the server (which refuses it again) or Whop.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// react-dom's useFormStatus is not in the test build; the button's pending state is not under test.
vi.mock('@/components/practitioners/PendingButton', () => ({
  PendingButton: ({ children }: { children: React.ReactNode }) => <button type="submit">{children}</button>,
}));

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

describe('the offerings list never calls an over-limit offering Live', () => {
  it('shows the limit message with Unpublish instead of "Live", and offers no Set up payments', async () => {
    const { OfferingsEditor } = await import('@/components/practitioners/OfferingsEditor');
    const noop = async () => undefined;
    const base = {
      description: null, interval: 'ONE_TIME' as const, category: null, duration: null, isConsult: false,
      acceptsPayments: true, bookingLinkId: null, listingVisibility: 'LISTED' as const,
    };
    act(() =>
      root.render(
        <OfferingsEditor
          offerings={[
            { ...base, id: 'o_live', title: 'Old program', priceUsdCents: 300_000, whopPlanId: 'plan_1', purchaseUrl: 'https://whop.com/c/x' },
            { ...base, id: 'o_new', title: 'New program', priceUsdCents: 500_000, whopPlanId: null, purchaseUrl: null },
          ]}
          payoutsEnabled
          whopConnected
          bookingLinks={[]}
          createAction={noop}
          updateAction={noop}
          deleteAction={noop}
          publishAction={noop}
          unpublishAction={noop}
          reorderAction={noop}
        />,
      ),
    );
    const text = host.textContent ?? '';
    expect(text).not.toMatch(/Live — patients can buy this/);
    expect(text).not.toMatch(/Set up payments/);
    expect(text.split(WHOP_OVER_LIMIT_MESSAGE).length - 1).toBeGreaterThanOrEqual(2);
    expect(text).toMatch(/Unpublish/);
  });
});
