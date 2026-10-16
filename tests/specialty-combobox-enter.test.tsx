// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { SpecialtyComboboxField } from '@/components/practitioners/SpecialtyComboboxField';

// Enter in the specialty combobox keeps the practitioner's own words (operator ruling
// 2026-10-15). It used to take suggestions[0], which for "anxiety" was the alias-matched
// "Stress / Sleep Optimization", silently swapping the concept on save.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OPTIONS = [
  { id: 's_sso', name: 'Stress / Sleep Optimization' },
  { id: 's_rei', name: 'Reiki' },
];
const ALIASES = [{ label: 'anxiety', specialtyId: 's_sso' }];

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<SpecialtyComboboxField options={OPTIONS} aliases={ALIASES} initial={[]} />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function typeAndEnter(text: string) {
  const input = host.querySelector<HTMLInputElement>('input[type="text"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    input.focus();
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
}

const submitted = () =>
  JSON.parse(host.querySelector<HTMLInputElement>('input[name="specialtiesJson"]')!.value);

describe('SpecialtyComboboxField Enter', () => {
  it('shows the alias suggestion, but Enter adds the typed words, not the aliased specialty', () => {
    const input = host.querySelector<HTMLInputElement>('input[type="text"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      input.focus();
      setter.call(input, 'anxiety');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // The suggestion is still offered for an explicit click.
    expect(host.textContent).toContain('Stress / Sleep Optimization');
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(submitted()).toEqual([{ specialtyId: null, rawLabel: 'anxiety' }]);
  });

  it('a partial match is not taken either', () => {
    typeAndEnter('Rei');
    expect(submitted()).toEqual([{ specialtyId: null, rawLabel: 'Rei' }]);
  });

  it('typing an existing name exactly takes that specialty', () => {
    typeAndEnter('reiki');
    expect(submitted()).toEqual([{ specialtyId: 's_rei', rawLabel: 'Reiki' }]);
  });
});
