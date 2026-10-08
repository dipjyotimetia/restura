import {
  type BranchId,
  branches,
  featurePosition,
  features,
  findFeatures,
  mapHeight,
  mapWidth,
  nodeHeight,
  nodeWidth,
  type Status,
  statuses,
} from '../data/product-tree';

function initializeTree() {
  const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const viewport = get<HTMLDivElement>('tree-viewport');
  if (!viewport) return;
  const canvas = get<HTMLDivElement>('tree-canvas');
  const list = get<HTMLDivElement>('feature-list');
  const panel = get<HTMLElement>('feature-detail');
  let expansionHeight = 0;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let expansionFrame: number | null = null;
  let cameraAnimation: Animation | null = null;
  let initialized = false;
  const search = get<HTMLInputElement>('feature-search');
  const results = get<HTMLUListElement>('search-results');
  const mobile = matchMedia('(max-width: 760px)');
  let view: 'tree' | 'list' = mobile.matches ? 'list' : 'tree';
  let filter: Status | 'all' = 'all';
  let activeBranch: BranchId | 'all' = 'all';
  let scale = 1;
  let offset = { x: 0, y: 0 };
  let returnFocus: HTMLElement | null = null;
  let selection: string | null = null;
  let dragging: { pointer: number; x: number; y: number; originX: number; originY: number } | null =
    null;
  const nodes = [...document.querySelectorAll<HTMLButtonElement>('[data-feature]')];
  const details = [...document.querySelectorAll<HTMLDetailsElement>('[data-list-feature]')];

  function paint(animate = false) {
    const previous = getComputedStyle(canvas).transform;
    cameraAnimation?.cancel();
    cameraAnimation = null;
    canvas.style.transform = `translate(${offset.x}px, ${offset.y}px) scale(${scale})`;
    if (animate && initialized && !reducedMotion.matches && previous !== 'none') {
      cameraAnimation = canvas.animate(
        [{ transform: previous }, { transform: canvas.style.transform }],
        { duration: 420, easing: 'cubic-bezier(.22, 1, .36, 1)' }
      );
    }
    get<HTMLOutputElement>('zoom-level').value = `${Math.round(scale * 100)}%`;
    get<HTMLButtonElement>('zoom-out').disabled = scale <= 0.1;
    get<HTMLButtonElement>('zoom-in').disabled = scale >= 1.6;
  }
  function fit(animate = true) {
    if (!viewport.clientWidth) return;
    scale = Math.max(
      0.1,
      Math.min(1, (viewport.clientWidth - 52) / mapWidth, (viewport.clientHeight - 88) / mapHeight)
    );
    offset = { x: (viewport.clientWidth - mapWidth * scale) / 2, y: 24 };
    paint(animate);
  }
  function zoom(multiplier: number, point?: { x: number; y: number }) {
    const next = Math.max(0.1, Math.min(1.6, scale * multiplier));
    const cx = point?.x ?? viewport.clientWidth / 2;
    const cy = point?.y ?? viewport.clientHeight / 2;
    offset = { x: cx - ((cx - offset.x) * next) / scale, y: cy - ((cy - offset.y) * next) / scale };
    scale = next;
    paint(!point);
  }
  function frameView() {
    if (activeBranch === 'all') {
      fit();
      return;
    }
    const index = branches.findIndex((branch) => branch.id === activeBranch);
    scale = Math.min(1.1, viewport.clientWidth / (nodeWidth + 160));
    offset = {
      x: viewport.clientWidth / 2 - (36 + index * 344 + nodeWidth / 2) * scale,
      y: 32 - 213 * scale,
    };
    paint(true);
  }
  function updateBranchControls() {
    document.querySelectorAll<HTMLElement>('[data-branch-filter]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.branchFilter === activeBranch));
    });
    document
      .querySelectorAll<HTMLElement>('[data-map-branch], [data-branch-edge]')
      .forEach((element) => {
        const branch = element.dataset.mapBranch ?? element.dataset.branchEdge;
        element.classList.toggle('branch-muted', activeBranch !== 'all' && branch !== activeBranch);
      });
    const label = branches.find((branch) => branch.id === activeBranch)?.label;
    search.placeholder = label ? `Search ${label.toLocaleLowerCase()}…` : 'Find a feature…';
  }
  function clearFilters() {
    filter = 'all';
    activeBranch = 'all';
    search.value = '';
    document.querySelectorAll<HTMLElement>('[data-filter]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.filter === 'all'));
    });
    updateBranchControls();
    applyFilters();
    if (view === 'tree') fit();
  }
  function setView(next: 'tree' | 'list') {
    closeFeature();
    view = next;
    viewport.hidden = view !== 'tree';
    get('tree-controls').hidden = view !== 'tree';
    list.hidden = view !== 'list';
    get('tree-view').setAttribute('aria-pressed', String(view === 'tree'));
    get('list-view').setAttribute('aria-pressed', String(view === 'list'));
    if (view === 'tree') frameView();
  }
  function dependencyLines(id: string) {
    const lines = document.getElementById('dependency-lines');
    if (!lines) return;
    lines.replaceChildren();
    const target = features.find((feature) => feature.id === id);
    if (!target) return;
    const end = positionFor(target);
    for (const prerequisite of target.prerequisites) {
      const source = features.find((feature) => feature.id === prerequisite);
      if (!source) continue;
      const start = positionFor(source);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute(
        'd',
        `M${start.x + nodeWidth} ${start.y + nodeHeight / 2} C${start.x + nodeWidth + 55} ${start.y + nodeHeight / 2},${end.x - 55} ${end.y + nodeHeight / 2},${end.x} ${end.y + nodeHeight / 2}`
      );
      path.setAttribute('class', 'dependency');
      lines.append(path);
    }
    nodes.forEach((node) => {
      node.classList.toggle('selected', node.dataset.feature === id);
      node.classList.toggle(
        'prerequisite',
        target.prerequisites.includes(node.dataset.feature ?? '')
      );
    });
  }
  function closeFeature(restoreFocus = false, updateUrl = true, animate = false) {
    if (animate && selection && !reducedMotion.matches) {
      animateExpansion(0, () => closeFeature(restoreFocus, updateUrl));
      return;
    }
    if (expansionFrame !== null) cancelAnimationFrame(expansionFrame);
    expansionFrame = null;
    panel.style.removeProperty('height');
    panel.style.removeProperty('overflow');
    panel.style.removeProperty('padding-block');
    const wasOpen = selection !== null;
    panel.hidden = true;
    selection = null;
    expansionHeight = 0;
    nodes.forEach((node) => node.setAttribute('aria-expanded', 'false'));
    details.forEach((detail) => {
      detail.open = false;
      detail.classList.remove('enhanced-detail');
      detail.querySelector('summary')?.setAttribute('aria-expanded', 'false');
    });
    document.querySelectorAll('.feature-card').forEach((card) => card.classList.remove('expanded'));
    document.getElementById('dependency-lines')?.replaceChildren();
    nodes.forEach((node) => node.classList.remove('selected', 'prerequisite'));
    layoutCards();
    if (updateUrl && wasOpen) history.replaceState(null, '', location.pathname + location.search);
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }
  function animateExpansion(target: number, onComplete?: () => void) {
    if (expansionFrame !== null) cancelAnimationFrame(expansionFrame);
    const startHeight = expansionHeight;
    const started = performance.now();
    const duration = target === 0 ? 220 : 340;
    const fullHeight = Math.max(startHeight, target, 1);
    panel.style.overflow = 'hidden';
    const step = (now: number) => {
      const progress = reducedMotion.matches ? 1 : Math.min(1, (now - started) / duration);
      const eased = 1 - (1 - progress) ** 3;
      expansionHeight = startHeight + (target - startHeight) * eased;
      panel.style.paddingBlock = `${18 * Math.min(1, expansionHeight / fullHeight)}px`;
      panel.style.height = `${expansionHeight}px`;
      if (view === 'tree') layoutCards();
      if (progress < 1) expansionFrame = requestAnimationFrame(step);
      else {
        expansionFrame = null;
        panel.style.removeProperty('height');
        panel.style.removeProperty('overflow');
        panel.style.removeProperty('padding-block');
        onComplete?.();
      }
    };
    if (reducedMotion.matches) step(started + duration);
    else {
      panel.style.paddingBlock = `${18 * Math.min(1, startHeight / fullHeight)}px`;
      panel.style.height = `${startHeight}px`;
      expansionFrame = requestAnimationFrame(step);
    }
  }
  function positionFor(feature: (typeof features)[number]) {
    const position = featurePosition(feature);
    const selected = features.find((item) => item.id === selection);
    if (selected && selected.branch === feature.branch && position.y > featurePosition(selected).y)
      position.y += expansionHeight;
    return position;
  }
  function layoutCards() {
    features.forEach((feature) => {
      const position = positionFor(feature);
      const card = document.querySelector<HTMLElement>(`[data-card="${feature.id}"]`);
      if (card) card.style.top = `${position.y}px`;
      document
        .querySelector(`[data-edge="${feature.id}"]`)
        ?.setAttribute('d', `M${position.x - 12} ${position.y + nodeHeight / 2} H${position.x}`);
    });
    branches.forEach((branch, index) => {
      const items = features.filter((feature) => feature.branch === branch.id);
      const last = items.at(-1);
      if (!last) return;
      const x = 36 + index * 344;
      const bottom =
        positionFor(last).y + nodeHeight / 2 + (last.id === selection ? expansionHeight : 0);
      document
        .querySelector(`[data-branch-edge="${branch.id}"] .branch-line`)
        ?.setAttribute(
          'd',
          `M${x + 138} 280 Q${x + 138} 294 ${x + 122} 294 H${x + 4} Q${x - 12} 294 ${x - 12} 310 V${bottom}`
        );
    });
    canvas.style.height = `${mapHeight + expansionHeight}px`;
    document
      .querySelector('.connections')
      ?.setAttribute('height', String(mapHeight + expansionHeight));
    document
      .querySelector('.connections')
      ?.setAttribute('viewBox', `0 0 ${mapWidth} ${mapHeight + expansionHeight}`);
    if (selection) dependencyLines(selection);
  }
  function showFeature(id: string, focusSource?: HTMLElement, updateUrl = true) {
    const feature = features.find((item) => item.id === id);
    if (!feature) return;
    if (selection === id && focusSource?.matches('[data-feature], summary')) {
      closeFeature(true, true, true);
      return;
    }
    closeFeature(false, false);
    returnFocus = focusSource ?? nodes.find((node) => node.dataset.feature === id) ?? null;
    // A prerequisite can be outside the current status/search selection. Reveal
    // it before centering so navigation never lands on a dimmed, disabled node.
    const selectedNode = nodes.find((node) => node.dataset.feature === id);
    if (selectedNode?.disabled) {
      filter = 'all';
      activeBranch = 'all';
      search.value = '';
      updateBranchControls();
      document.querySelectorAll<HTMLElement>('[data-filter]').forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.filter === 'all'));
      });
      applyFilters();
      results.hidden = true;
    }
    selection = id;
    get('detail-platform-heading').textContent =
      feature.status === 'shipped'
        ? 'Available on'
        : feature.status === 'in-progress'
          ? 'Applies to'
          : 'Intended platforms';
    get('detail-title').textContent = feature.title;
    get('detail-description').textContent = feature.description;
    const status = get('detail-status');
    status.textContent = statuses[feature.status];
    status.className = `detail-status ${feature.status}`;
    get('detail-platforms').textContent = feature.platforms.join(' / ');
    get('detail-planned-note').hidden =
      feature.status === 'shipped' || feature.status === 'in-progress';
    const prerequisiteSection = get('detail-prerequisites');
    prerequisiteSection.hidden = feature.prerequisites.length === 0;
    const prerequisiteList = prerequisiteSection.querySelector('ul');
    prerequisiteList?.replaceChildren();
    for (const prerequisite of feature.prerequisites) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.textContent =
        features.find((candidate) => candidate.id === prerequisite)?.title ?? prerequisite;
      button.addEventListener('click', () => showFeature(prerequisite));
      item.append(button);
      prerequisiteList?.append(item);
    }
    const unlocks = get('detail-unlocks');
    const children = features.filter((candidate) => candidate.prerequisites.includes(id));
    unlocks.hidden = children.length === 0;
    const childList = unlocks.querySelector('ul');
    childList?.replaceChildren();
    for (const child of children) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.textContent = `${child.title} — ${statuses[child.status]}`;
      button.addEventListener('click', () => showFeature(child.id));
      item.append(button);
      childList?.append(item);
    }
    const docs = get<HTMLAnchorElement>('detail-docs');
    docs.hidden = !feature.href;
    if (feature.href) docs.href = feature.href;
    else docs.removeAttribute('href');
    get('copy-status').textContent = '';
    panel.hidden = false;
    if (view === 'tree') {
      const card = document.querySelector<HTMLElement>(`[data-card="${id}"]`);
      card?.append(panel);
      card?.classList.add('expanded');
      selectedNode?.setAttribute('aria-expanded', 'true');
      animateExpansion(panel.offsetHeight);
      // Search and relationship links reveal their destination; direct box
      // clicks leave the camera exactly where the user put it.
      if (!focusSource || focusSource === search) {
        scale = Math.max(1, scale);
        const position = featurePosition(feature);
        offset = {
          x: viewport.clientWidth / 2 - (position.x + nodeWidth / 2) * scale,
          y: 32 - position.y * scale,
        };
        paint(true);
      }
    } else {
      const detail = details.find((item) => item.dataset.listFeature === id);
      detail?.querySelector('.list-detail')?.append(panel);
      if (detail) {
        detail.open = true;
        detail.classList.add('enhanced-detail');
      }
      detail?.querySelector('summary')?.setAttribute('aria-expanded', 'true');
      animateExpansion(panel.offsetHeight);
      if (!focusSource || focusSource === search) detail?.scrollIntoView({ block: 'nearest' });
    }
    if (updateUrl) history.replaceState(null, '', `#${id}`);
    if (!focusSource || focusSource === search) get('detail-title').focus({ preventScroll: true });
  }
  function applyFilters() {
    if (selection) closeFeature();
    const query = search.value.trim().toLocaleLowerCase();
    const matching = findFeatures(query, filter, activeBranch);
    const scope = features.filter(
      (feature) => activeBranch === 'all' || feature.branch === activeBranch
    );
    document.querySelectorAll<HTMLElement>('[data-filter]').forEach((button) => {
      const span = button.querySelector('span');
      if (span)
        span.textContent = String(
          scope.filter(
            (feature) => button.dataset.filter === 'all' || feature.status === button.dataset.filter
          ).length
        );
    });
    get('clear-search').hidden = !search.value;
    const ids = new Set(matching.map((feature) => feature.id));
    nodes.forEach((node) => {
      const matches = ids.has(node.dataset.feature ?? '');
      node.classList.toggle('dimmed', !matches);
      node.disabled = !matches;
    });
    details.forEach((detail) => {
      detail.hidden = !ids.has(detail.dataset.listFeature ?? '');
    });
    document.querySelectorAll<HTMLElement>('[data-list-branch]').forEach((branch) => {
      branch.hidden = !matching.some((feature) => feature.branch === branch.dataset.listBranch);
    });
    get('result-count').textContent =
      `${matching.length} of ${scope.length} features${activeBranch !== 'all' ? ` in ${branches.find((branch) => branch.id === activeBranch)?.label}` : ''}${query ? ` matching “${search.value.trim()}”` : ''}`;
    get('empty-state').hidden = matching.length !== 0;
    results.replaceChildren();
    results.hidden = !query;
    for (const feature of matching) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.textContent = `${feature.title} — ${statuses[feature.status]}`;
      button.addEventListener('click', () => {
        results.hidden = true;
        showFeature(feature.id, search);
      });
      item.append(button);
      results.append(item);
    }
    if (query && !matching.length) {
      const item = document.createElement('li');
      item.textContent = 'No matching features.';
      results.append(item);
    }
  }

  // Reveal controls only after every required element has been found.
  document.documentElement.classList.add('tree-ready');
  document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((button) => {
    button.disabled = false;
  });
  setView(view);
  nodes.forEach((node) =>
    node.addEventListener('click', () => showFeature(node.dataset.feature ?? '', node))
  );
  details.forEach((detail) => {
    const summary = detail.querySelector('summary');
    summary?.setAttribute('aria-controls', 'feature-detail');
    summary?.setAttribute('aria-expanded', 'false');
    summary?.addEventListener('click', (event) => {
      event.preventDefault();
      showFeature(detail.dataset.listFeature ?? '', event.currentTarget as HTMLElement);
    });
  });
  get('tree-view').addEventListener('click', () => setView('tree'));
  get('list-view').addEventListener('click', () => setView('list'));
  get('zoom-in').addEventListener('click', () => zoom(1.2));
  get('zoom-out').addEventListener('click', () => zoom(1 / 1.2));
  get('reset-map').addEventListener('click', () => {
    activeBranch = 'all';
    updateBranchControls();
    applyFilters();
    fit();
  });
  document.querySelectorAll<HTMLButtonElement>('[data-branch-filter]').forEach((button) =>
    button.addEventListener('click', () => {
      activeBranch = button.dataset.branchFilter as BranchId | 'all';
      updateBranchControls();
      applyFilters();
      results.hidden = true;
      if (view === 'tree') frameView();
    })
  );
  get('clear-filters').addEventListener('click', () => {
    clearFilters();
    search.focus();
  });
  get('clear-search').addEventListener('click', () => {
    search.value = '';
    applyFilters();
    search.focus();
  });
  get('close-detail').addEventListener('click', () => closeFeature(true, true, true));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && selection) closeFeature(true, true, true);
  });
  get('copy-link').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(`${location.origin}${location.pathname}#${selection}`);
      get('copy-status').textContent = 'Link copied.';
    } catch {
      get('copy-status').textContent = 'Copy the feature link from your address bar.';
    }
  });
  get('theme-toggle').addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    get('theme-toggle').setAttribute(
      'aria-label',
      `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`
    );
  });
  document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((button) =>
    button.addEventListener('click', () => {
      filter = button.dataset.filter as Status | 'all';
      document
        .querySelectorAll('[data-filter]')
        .forEach((candidate) =>
          candidate.setAttribute('aria-pressed', String(candidate === button))
        );
      applyFilters();
    })
  );
  search.addEventListener('input', applyFilters);
  search.addEventListener('focus', () => {
    if (search.value.trim()) applyFilters();
  });
  results.addEventListener('keydown', (event) => {
    const buttons = [...results.querySelectorAll('button')];
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = index + (event.key === 'ArrowDown' ? 1 : -1);
      if (next < 0) search.focus();
      else buttons[next % buttons.length]?.focus();
    }
    if (event.key === 'Escape') {
      results.hidden = true;
      search.focus();
      results.hidden = true;
    }
  });
  search.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      results.querySelector('button')?.focus();
    }
    if (event.key === 'Escape') results.hidden = true;
    if (event.key === 'Enter') {
      event.preventDefault();
      results.querySelector('button')?.click();
    }
  });
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || !event.target.closest('.search-wrap'))
      results.hidden = true;
  });
  viewport.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const area = viewport.getBoundingClientRect();
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
      zoom(Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.0015), {
        x: event.clientX - area.left,
        y: event.clientY - area.top,
      });
    },
    { passive: false }
  );
  viewport.addEventListener('pointerdown', (event) => {
    if (
      event.button !== 0 ||
      (event.target instanceof Element && event.target.closest('button, a, .inline-feature-detail'))
    )
      return;
    if (cameraAnimation?.playState === 'running') {
      const current = new DOMMatrixReadOnly(getComputedStyle(canvas).transform);
      scale = current.a;
      offset = { x: current.e, y: current.f };
      paint();
    }
    dragging = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      originX: offset.x,
      originY: offset.y,
    };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add('dragging');
  });
  viewport.addEventListener('pointermove', (event) => {
    if (!dragging || dragging.pointer !== event.pointerId) return;
    offset = {
      x: dragging.originX + event.clientX - dragging.x,
      y: dragging.originY + event.clientY - dragging.y,
    };
    paint();
  });
  const endDrag = () => {
    dragging = null;
    viewport.classList.remove('dragging');
  };
  viewport.addEventListener('pointerup', endDrag);
  viewport.addEventListener('pointercancel', endDrag);
  viewport.addEventListener('lostpointercapture', endDrag);
  viewport.addEventListener('keydown', (event) => {
    if (event.target !== viewport) return;
    const directions: Record<string, [number, number]> = {
      ArrowLeft: [60, 0],
      ArrowRight: [-60, 0],
      ArrowUp: [0, 60],
      ArrowDown: [0, -60],
    };
    const movement = directions[event.key];
    if (movement) {
      event.preventDefault();
      offset.x += movement[0];
      offset.y += movement[1];
      paint();
    }
    if (event.key === '+' || event.key === '=') zoom(1.2);
    if (event.key === '-') zoom(1 / 1.2);
    if (event.key === 'Home') {
      event.preventDefault();
      get<HTMLButtonElement>('reset-map').click();
    }
  });
  viewport.addEventListener('focusin', (event) => {
    const node = event.target;
    if (!(node instanceof HTMLButtonElement) || !node.dataset.feature) return;
    const feature = features.find((item) => item.id === node.dataset.feature);
    if (!feature) return;
    const box = node.getBoundingClientRect();
    const area = viewport.getBoundingClientRect();
    if (
      box.left < area.left ||
      box.right > area.right ||
      box.top < area.top ||
      box.bottom > area.bottom - 64
    ) {
      const position = positionFor(feature);
      offset = {
        x: viewport.clientWidth / 2 - (position.x + nodeWidth / 2) * scale,
        y: viewport.clientHeight / 2 - (position.y + nodeHeight / 2) * scale,
      };
      paint();
    }
  });
  const onHash = () => {
    const id = location.hash.slice(1);
    if (features.some((feature) => feature.id === id)) {
      // Preserve the incoming fragment while replacing an open selection.
      closeFeature(false, false);
      const feature = features.find((item) => item.id === id);
      if (feature) {
        activeBranch = feature.branch;
        updateBranchControls();
        applyFilters();
      }
      showFeature(id, undefined, false);
      if (view === 'tree' && feature) {
        activeBranch = feature.branch;
        updateBranchControls();
        frameView();
        const position = featurePosition(feature);
        offset.y = 48 - position.y * scale;
        paint();
      } else
        details
          .find((detail) => detail.dataset.listFeature === id)
          ?.scrollIntoView({ block: 'nearest' });
    } else if (selection) closeFeature(false, false);
  };
  window.addEventListener('hashchange', onHash);
  const observer = new ResizeObserver(() => {
    if (view === 'tree' && !selection) frameView();
  });
  observer.observe(viewport);
  new ResizeObserver(() => {
    if (
      selection &&
      view === 'tree' &&
      expansionFrame === null &&
      Math.abs(expansionHeight - panel.offsetHeight) > 0.5
    ) {
      expansionHeight = panel.offsetHeight;
      layoutCards();
    }
  }).observe(panel);
  mobile.addEventListener('change', () => setView(mobile.matches ? 'list' : 'tree'));
  applyFilters();
  initialized = true;
  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) cameraAnimation?.cancel();
  });
  // Allow native fragment navigation to finish before framing a linked feature.
  if (document.readyState === 'complete') requestAnimationFrame(onHash);
  else window.addEventListener('load', () => requestAnimationFrame(onHash), { once: true });
}
initializeTree();
