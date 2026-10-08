import { beforeEach, expect, it } from 'vitest';
import { initDeliveryPlan } from '../src/scripts/delivery-plan';

const card = (id: string, branch: string, text: string) =>
  `<li class="dp-card" id="plan-${id}" data-branch="${branch}" data-search="${text}"><details></details></li>`;

beforeEach(() => {
  history.replaceState(null, '', '/overview/delivery-plan/#plan-ai-web');
  document.body.innerHTML = `
    <div data-delivery-plan>
      <div data-enhanced hidden>
        <button data-horizon-filter="all"></button><button data-horizon-filter="planned"></button>
        <button data-branch-filter="all"></button><button data-branch-filter="ai"></button>
        <input data-plan-search /><p data-plan-count></p>
      </div>
      <section data-horizon="in-progress"><ol>${card('contracts', 'automation', 'contract testing openapi')}</ol></section>
      <section data-horizon="planned"><ol>${card('ai-web', 'ai', 'ai assistant on web')}${card('pac-proxy', 'security', 'pac proxy scripts')}</ol></section>
      <div data-plan-empty hidden><button data-plan-clear></button></div>
    </div>`;
  initDeliveryPlan();
});

const visible = () =>
  [...document.querySelectorAll<HTMLElement>('.dp-card')]
    .filter((item) => !item.hidden && !item.closest<HTMLElement>('[data-horizon]')!.hidden)
    .map((item) => item.id);

it('reveals the controls and counts every item', () => {
  expect(document.querySelector<HTMLElement>('[data-enhanced]')!.hidden).toBe(false);
  expect(document.querySelector('[data-plan-count]')!.textContent).toBe('3 of 3 items shown');
});

it('combines horizon, branch, and search filters, and hides empty horizons', () => {
  document.querySelector<HTMLButtonElement>('[data-branch-filter="ai"]')!.click();
  expect(visible()).toEqual(['plan-ai-web']);
  expect(document.querySelector<HTMLElement>('[data-horizon="in-progress"]')!.hidden).toBe(true);
  document.querySelector<HTMLButtonElement>('[data-branch-filter="all"]')!.click();
  document.querySelector<HTMLButtonElement>('[data-horizon-filter="planned"]')!.click();
  const search = document.querySelector<HTMLInputElement>('[data-plan-search]')!;
  search.value = 'PAC  proxy';
  search.dispatchEvent(new Event('input'));
  expect(visible()).toEqual(['plan-pac-proxy']);
});

it('shows an empty state that clears every filter', () => {
  const search = document.querySelector<HTMLInputElement>('[data-plan-search]')!;
  search.value = 'nothing-matches';
  search.dispatchEvent(new Event('input'));
  expect(document.querySelector<HTMLElement>('[data-plan-empty]')!.hidden).toBe(false);
  document.querySelector<HTMLButtonElement>('[data-plan-clear]')!.click();
  expect(visible()).toHaveLength(3);
  expect(search.value).toBe('');
});

it('opens the checklist of a deep-linked item', () => {
  expect(document.querySelector('#plan-ai-web details')!.hasAttribute('open')).toBe(true);
});
