// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { SpecialtyComboboxField } from '@/components/practitioners/SpecialtyComboboxField';

// tsk_eb9ee4d9 item 1: onboarding cannot be submitted without a specialty. The selections travel
// in a hidden input, which the browser never validates, so the visible box carries the state.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HINT = 'Add at least one specialty, in your own words, so clients can find you in search.';
const OPTIONS = [{ id: 's_rei', name: 'Reiki' }];

let root: Root;
let host: HTMLFormElement;

function mount(props: Partial<Parameters<typeof SpecialtyComboboxField>[0]>) {
  act(() =>
    root.render(
      <SpecialtyComboboxField options={OPTIONS} aliases={[]} initial={[]} {...props} />,
    ),
  );
}

beforeEach(() => {
  host = document.createElement('form');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const box = () => host.querySelector<HTMLInputElement>('input[type="text"]')!;

function typeAndEnter(text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    box().focus();
    setter.call(box(), text);
    box().dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => {
    box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
}

describe('required specialty combobox', () => {
  it('blocks the form with the hint until a specialty is added', () => {
    mount({ required: true, requiredMessage: HINT });
    expect(host.checkValidity()).toBe(false);
    expect(box().validationMessage).toBe(HINT);
    expect(box().getAttribute('aria-invalid')).toBe('true');

    typeAndEnter('Gut health');
    expect(host.checkValidity()).toBe(true);
    expect(box().validationMessage).toBe('');
  });

  it('typed text that was never added does not count', () => {
    mount({ required: true, requiredMessage: HINT });
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(box(), 'Gut health');
      box().dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.checkValidity()).toBe(false);
  });

  it('removing the last specialty blocks the form again', () => {
    mount({ required: true, requiredMessage: HINT, initial: [{ specialtyId: 's_rei', rawLabel: 'Reiki' }] });
    expect(host.checkValidity()).toBe(true);
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Remove Reiki"]')!.click());
    expect(host.checkValidity()).toBe(false);
  });

  it('is optional everywhere else (the /edit page does not pass required)', () => {
    mount({});
    expect(host.checkValidity()).toBe(true);
  });
});

describe('the onboarding form asks for it near the top', () => {
  const src = readFileSync(
    join(__dirname, '..', 'src', 'components', 'practitioners', 'OnboardingForm.tsx'),
    'utf8',
  );

  it('shows the hint, marks the field required and passes required to the combobox', () => {
    expect(src).toContain(HINT);
    expect(src).toMatch(/<Field label="Specialties" required/);
    expect(src).toMatch(/<SpecialtyComboboxField[\s\S]*?\brequired\b[\s\S]*?\/>/);
  });

  it('puts Specialties straight after the name, before the practice description', () => {
    const name = src.indexOf('name="displayName"');
    const specialties = src.indexOf('<SpecialtyComboboxField');
    const describe = src.indexOf('label="Describe your practice"');
    expect(name).toBeGreaterThan(-1);
    expect(specialties).toBeGreaterThan(name);
    expect(describe).toBeGreaterThan(specialties);
  });
});
