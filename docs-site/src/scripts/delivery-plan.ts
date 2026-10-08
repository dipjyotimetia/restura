/** Progressive enhancement for the delivery plan: the page is complete without
 * JavaScript; this adds horizon/branch/search filters and reveal motion. */
export function initDeliveryPlan(root: ParentNode = document): void {
  const plan = root.querySelector<HTMLElement>('[data-delivery-plan]');
  if (!plan) return;
  const controls = plan.querySelector<HTMLElement>('[data-enhanced]');
  const search = plan.querySelector<HTMLInputElement>('[data-plan-search]');
  const count = plan.querySelector<HTMLElement>('[data-plan-count]');
  const empty = plan.querySelector<HTMLElement>('[data-plan-empty]');
  const sections = [...plan.querySelectorAll<HTMLElement>('[data-horizon]')];
  const cards = [...plan.querySelectorAll<HTMLElement>('.dp-card')];
  let horizon = 'all';
  let branch = 'all';

  function press(selector: string, value: string) {
    plan?.querySelectorAll<HTMLElement>(selector).forEach((button) => {
      const key = button.dataset.horizonFilter ?? button.dataset.branchFilter;
      button.setAttribute('aria-pressed', String(key === value));
    });
  }

  function apply() {
    const terms = (search?.value ?? '').toLocaleLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const section of sections) {
      let visible = 0;
      for (const card of section.querySelectorAll<HTMLElement>('.dp-card')) {
        const text = card.dataset.search ?? '';
        const match =
          (branch === 'all' || card.dataset.branch === branch) &&
          terms.every((term) => text.includes(term));
        card.hidden = !match;
        if (match) visible++;
      }
      section.hidden = visible === 0 || (horizon !== 'all' && section.dataset.horizon !== horizon);
      if (!section.hidden) shown += visible;
    }
    if (count) count.textContent = `${shown} of ${cards.length} items shown`;
    if (empty) empty.hidden = shown !== 0;
  }

  plan.querySelectorAll<HTMLButtonElement>('[data-horizon-filter]').forEach((button) =>
    button.addEventListener('click', () => {
      horizon = button.dataset.horizonFilter ?? 'all';
      press('[data-horizon-filter]', horizon);
      apply();
    })
  );
  plan.querySelectorAll<HTMLButtonElement>('[data-branch-filter]').forEach((button) =>
    button.addEventListener('click', () => {
      branch = button.dataset.branchFilter ?? 'all';
      press('[data-branch-filter]', branch);
      apply();
    })
  );
  search?.addEventListener('input', apply);
  plan.querySelector('[data-plan-clear]')?.addEventListener('click', () => {
    horizon = 'all';
    branch = 'all';
    if (search) search.value = '';
    press('[data-horizon-filter]', 'all');
    press('[data-branch-filter]', 'all');
    apply();
    search?.focus();
  });

  if (controls) controls.hidden = false;
  apply();

  // A #plan-<id> link opens that card's checklist.
  const target = location.hash.startsWith('#plan-')
    ? plan.querySelector<HTMLElement>(location.hash)
    : null;
  target?.querySelector('details')?.setAttribute('open', '');

  // Cards rise and their progress fills as they scroll into view. Without
  // IntersectionObserver (or with reduced motion) everything is shown at once.
  const reveal = (element: Element) => element.classList.add('is-visible');
  const stats = plan.querySelector('.dp-stats');
  if (!('IntersectionObserver' in window)) return;
  document.documentElement.classList.add('dp-ready');
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        reveal(entry.target);
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -8% 0px' }
  );
  for (const card of cards) observer.observe(card);
  if (stats) observer.observe(stats);
  if (target) reveal(target);
}
