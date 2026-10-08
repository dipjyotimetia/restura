import {
  type BranchId,
  branches,
  branchLeft,
  branchWidth,
  featurePosition,
  features,
  findFeatures,
  fitScale,
  labelWidth,
  layout,
  mapHeight,
  mapWidth,
  nodeSize,
  type Status,
  statuses,
  treeParent,
} from '../data/product-tree';

function initializeTree() {
  const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const viewport = get<HTMLDivElement>('tree-viewport');
  if (!viewport) return;
  const canvas = get<HTMLDivElement>('tree-canvas');
  const list = get<HTMLDivElement>('feature-list');
  const panel = get<HTMLElement>('feature-detail');
  const stage = viewport.closest<HTMLElement>('.map-stage');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let cameraAnimation: Animation | null = null;
  let initialized = false;
  const search = get<HTMLInputElement>('feature-search');
  const results = get<HTMLUListElement>('search-results');
  let view: 'tree' | 'list' = 'tree';
  let filter: Status | 'all' = 'all';
  let activeBranch: BranchId | 'all' = 'all';
  let scale = 1;
  let offset = { x: 0, y: 0 };
  // Once the user pans or zooms, resizes keep their camera instead of re-fitting.
  let userMoved = false;
  let returnFocus: HTMLElement | null = null;
  let selection: string | null = null;
  let dragging: {
    pointer: number;
    x: number;
    y: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null = null;
  // A drag that started on a card must not also open it when the pointer lifts.
  let suppressClick = false;
  // Active touch/pen pointers; two of them pinch-zoom around their midpoint.
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDistance = 0;
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
    placePanel();
  }
  /** Anchors the tree-view details beside the selected node, flipping to its left
   * near the right edge. Narrow maps show it as a bottom sheet instead (CSS). */
  function placePanel() {
    if (view !== 'tree' || !selection || panel.hidden) return;
    const feature = features.find((item) => item.id === selection);
    if (!feature) return;
    const sheet = viewport.clientWidth < 640;
    panel.classList.toggle('detail-sheet', sheet);
    if (sheet) {
      panel.style.removeProperty('left');
      panel.style.removeProperty('top');
      return;
    }
    const { x, y } = featurePosition(feature);
    const gap = 14;
    const width = panel.offsetWidth || 340;
    const right = offset.x + (x + labelWidth / 2) * scale + gap;
    const left =
      right + width <= viewport.clientWidth - gap
        ? right
        : offset.x + (x - labelWidth / 2) * scale - gap - width;
    const top = offset.y + (y - nodeSize / 2) * scale;
    panel.style.left = `${viewport.offsetLeft + Math.max(gap, Math.min(viewport.clientWidth - width - gap, left))}px`;
    panel.style.top = `${viewport.offsetTop + Math.max(gap, Math.min(viewport.clientHeight - panel.offsetHeight - gap, top))}px`;
  }
  function fit(animate = true) {
    if (!viewport.clientWidth) return;
    scale = fitScale(viewport.clientWidth, viewport.clientHeight);
    // A map wider than the viewport (phones) starts at its first column.
    const whole = mapWidth * scale <= viewport.clientWidth;
    // The root sits off-screen in that case, so begin at the branch hubs.
    offset = whole
      ? { x: (viewport.clientWidth - mapWidth * scale) / 2, y: 16 }
      : { x: 0, y: 16 - (layout.hubY - 60) * scale };
    userMoved = false;
    paint(animate);
  }
  function zoom(multiplier: number, point?: { x: number; y: number }) {
    userMoved = true;
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
    const width = branchWidth(index);
    scale = Math.min(1.1, viewport.clientWidth / (width + 120));
    offset = {
      x: viewport.clientWidth / 2 - (branchLeft(index) + width / 2) * scale,
      y: 32 - (layout.hubY - 40) * scale,
    };
    userMoved = false;
    paint(true);
  }
  /** Pans for a user gesture, stopping a small margin past the map's edges so it
   * never scrolls away into empty canvas. Returns false when the map is already
   * against that edge. */
  function panTo(next: { x: number; y: number }) {
    const margin = 40;
    const bound = (value: number, viewportSize: number, mapSize: number) => {
      const far = viewportSize - mapSize * scale - margin;
      return Math.min(Math.max(margin, far), Math.max(Math.min(margin, far), value));
    };
    const clamped = {
      x: bound(next.x, viewport.clientWidth, mapWidth),
      y: bound(next.y, viewport.clientHeight, mapHeight),
    };
    if (clamped.x === offset.x && clamped.y === offset.y) return false;
    userMoved = true;
    offset = clamped;
    paint();
    return true;
  }
  function dismissHint() {
    get('tree-controls').classList.add('hint-dismissed');
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
    viewport.closest('.map-stage')?.toggleAttribute('hidden', view !== 'tree');
    get('tree-controls').hidden = view !== 'tree';
    list.hidden = view !== 'list';
    get('tree-view').setAttribute('aria-pressed', String(view === 'tree'));
    get('list-view').setAttribute('aria-pressed', String(view === 'list'));
    if (view === 'tree') frameView();
  }
  function dependencyLines(id: string) {
    const lines = document.getElementById('dependency-lines');
    if (!lines) return;
    const target = features.find((feature) => feature.id === id);
    if (!target) {
      lines.replaceChildren();
      return;
    }
    lines.replaceChildren();
    const end = featurePosition(target);
    const sources = target.prerequisites
      .map((prerequisite) => features.find((feature) => feature.id === prerequisite))
      .filter((source) => source !== undefined);
    sources.forEach((source, index) => {
      const start = featurePosition(source);
      let path = lines.children[index];
      if (!path) {
        path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('class', 'dependency');
        lines.append(path);
      }
      // Circle centre to circle centre; the nodes cover the ends.
      const bend = Math.max(60, Math.abs(end.x - start.x) / 2);
      path.setAttribute(
        'd',
        `M${start.x} ${start.y} C${start.x + bend} ${start.y},${end.x - bend} ${end.y},${end.x} ${end.y}`
      );
    });
    lineage(target);
    nodes.forEach((node) => {
      node.classList.toggle('selected', node.dataset.feature === id);
      node.classList.toggle(
        'prerequisite',
        target.prerequisites.includes(node.dataset.feature ?? '')
      );
    });
  }
  /** Traces the selected feature back to the root: the trunk, its branch's link,
   * then each ancestor's line, drawn in that order so the path reads top-down. */
  function lineage(target: (typeof features)[number]) {
    const group = document.getElementById('lineage-lines');
    if (!group) return;
    const chain: (typeof features)[number][] = [];
    for (let item: (typeof features)[number] | undefined = target; item; item = treeParent(item))
      chain.unshift(item);
    const sources = [
      document.querySelector('.connections .trunk'),
      document.querySelector(`[data-branch-edge="${target.branch}"] .root-link`),
      ...chain.map((item) => document.querySelector(`[data-edge="${item.id}"]`)),
    ];
    group.replaceChildren(
      ...sources
        .filter((source) => source !== null)
        .map((source, index) => {
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('class', 'lineage');
          path.setAttribute('pathLength', '1');
          path.setAttribute('d', source.getAttribute('d') ?? '');
          path.style.setProperty('--step', `${index * 110}ms`);
          return path;
        })
    );
  }
  function closeFeature(restoreFocus = false, updateUrl = true) {
    const wasOpen = selection !== null;
    panel.hidden = true;
    panel.classList.remove('detail-sheet');
    selection = null;
    nodes.forEach((node) => node.setAttribute('aria-expanded', 'false'));
    details.forEach((detail) => {
      detail.open = false;
      detail.classList.remove('enhanced-detail');
      detail.querySelector('summary')?.setAttribute('aria-expanded', 'false');
    });
    get('dependency-lines')?.replaceChildren();
    get('lineage-lines')?.replaceChildren();
    nodes.forEach((node) => node.classList.remove('selected', 'prerequisite'));
    if (updateUrl && wasOpen) history.replaceState(null, '', location.pathname + location.search);
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }
  function showFeature(id: string, focusSource?: HTMLElement, updateUrl = true) {
    const feature = features.find((item) => item.id === id);
    if (!feature) return;
    if (selection === id && focusSource?.matches('[data-feature], summary')) {
      closeFeature(true);
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
    // Optional: unshipped work links to its milestone checklist.
    const planLink = document.getElementById('detail-plan') as HTMLAnchorElement | null;
    if (planLink) {
      planLink.hidden = !feature.plan;
      planLink.href = `/overview/delivery-plan/#plan-${feature.id}`;
    }
    const docs = get<HTMLAnchorElement>('detail-docs');
    docs.hidden = !feature.href;
    if (feature.href) docs.href = feature.href;
    else docs.removeAttribute('href');
    get('copy-status').textContent = '';
    panel.hidden = false;
    if (view === 'tree') {
      // Details float over the map, so opening one never moves another node.
      stage?.append(panel);
      selectedNode?.setAttribute('aria-expanded', 'true');
      dependencyLines(id);
      // Search and relationship links reveal their destination, leaving room for
      // the details on the right; direct node clicks keep the user's camera.
      if (!focusSource || focusSource === search) {
        scale = Math.max(1, scale);
        const position = featurePosition(feature);
        offset = {
          x: viewport.clientWidth / 3 - position.x * scale,
          y: 140 - position.y * scale,
        };
        userMoved = true;
        paint(true);
      } else placePanel();
    } else {
      const detail = details.find((item) => item.dataset.listFeature === id);
      detail?.querySelector('.list-detail')?.append(panel);
      if (detail) {
        detail.open = true;
        detail.classList.add('enhanced-detail');
      }
      detail?.querySelector('summary')?.setAttribute('aria-expanded', 'true');
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
      // Filtering quietens the line into a node along with the node itself.
      document
        .querySelector(`[data-edge="${node.dataset.feature}"]`)
        ?.classList.toggle('dimmed', !matches);
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
  get('close-detail').addEventListener('click', () => closeFeature(true));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && selection) closeFeature(true);
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
      dismissHint();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      // Ctrl/⌘ + wheel zooms; trackpad pinch arrives as a ctrlKey wheel too.
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const area = viewport.getBoundingClientRect();
        const delta = event.deltaY * unit;
        zoom(Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.0015), {
          x: event.clientX - area.left,
          y: event.clientY - area.top,
        });
        return;
      }
      // Plain wheel pans like a document; Shift turns a vertical wheel horizontal.
      const horizontal = event.shiftKey && !event.deltaX;
      const moved = panTo({
        x: offset.x - (horizontal ? event.deltaY : event.deltaX) * unit,
        y: offset.y - (horizontal ? 0 : event.deltaY) * unit,
      });
      // At the map's edge the wheel scrolls the page instead of being trapped.
      if (moved) event.preventDefault();
    },
    { passive: false }
  );
  viewport.addEventListener('pointerdown', (event) => {
    suppressClick = false;
    if (
      event.button !== 0 ||
      (event.target instanceof Element && event.target.closest('a, .inline-feature-detail'))
    )
      return;
    // Gestures may start on a card (most of a phone screen). A tap still opens it:
    // pointer capture, which retargets the click, only begins once the pointer moves.
    if (cameraAnimation?.playState === 'running') {
      const current = new DOMMatrixReadOnly(getComputedStyle(canvas).transform);
      scale = current.a;
      offset = { x: current.e, y: current.f };
      paint();
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      for (const id of pointers.keys()) viewport.setPointerCapture(id);
      const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
      dragging = null;
      suppressClick = true;
      dismissHint();
      return;
    }
    dragging = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      originX: offset.x,
      originY: offset.y,
      moved: false,
    };
  });
  viewport.addEventListener('pointermove', (event) => {
    if (pointers.has(event.pointerId))
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2 && pinchDistance) {
      const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const area = viewport.getBoundingClientRect();
      zoom(distance / pinchDistance, {
        x: (a.x + b.x) / 2 - area.left,
        y: (a.y + b.y) / 2 - area.top,
      });
      pinchDistance = distance;
      return;
    }
    if (!dragging || dragging.pointer !== event.pointerId) return;
    const dx = event.clientX - dragging.x;
    const dy = event.clientY - dragging.y;
    if (!dragging.moved) {
      if (Math.hypot(dx, dy) < 6) return;
      dragging.moved = true;
      suppressClick = true;
      viewport.setPointerCapture(event.pointerId);
      viewport.classList.add('dragging');
      dismissHint();
    }
    panTo({ x: dragging.originX + dx, y: dragging.originY + dy });
  });
  const endDrag = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchDistance = 0;
    viewport.classList.remove('dragging');
    // The finger left on the screen after a pinch carries on panning.
    const [remaining] = [...pointers.entries()];
    dragging = remaining
      ? {
          pointer: remaining[0],
          x: remaining[1].x,
          y: remaining[1].y,
          originX: offset.x,
          originY: offset.y,
          moved: true,
        }
      : null;
  };
  viewport.addEventListener('pointerup', endDrag);
  viewport.addEventListener('pointercancel', endDrag);
  viewport.addEventListener('lostpointercapture', endDrag);
  viewport.addEventListener(
    'click',
    (event) => {
      if (suppressClick) {
        event.preventDefault();
        event.stopPropagation();
      } else if (
        selection &&
        event.target instanceof Element &&
        !event.target.closest('[data-feature]')
      )
        // A tap on the open map dismisses the details.
        closeFeature();
      suppressClick = false;
    },
    true
  );
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
      panTo({ x: offset.x + movement[0], y: offset.y + movement[1] });
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
      const position = featurePosition(feature);
      offset = {
        x: viewport.clientWidth / 2 - position.x * scale,
        y: viewport.clientHeight / 2 - position.y * scale,
      };
      userMoved = true;
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
      if (view === 'list')
        details
          .find((detail) => detail.dataset.listFeature === id)
          ?.scrollIntoView({ block: 'nearest' });
    } else if (selection) closeFeature(false, false);
  };
  window.addEventListener('hashchange', onHash);
  const observer = new ResizeObserver(() => {
    if (view === 'tree' && !selection && !userMoved) frameView();
    else placePanel();
  });
  observer.observe(viewport);
  applyFilters();
  initialized = true;
  // Entrance animations play once; without this they'd replay (hiding cards for
  // their delay) whenever the map is shown again after List view.
  setTimeout(() => document.documentElement.classList.add('tree-entered'), 2800);
  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) cameraAnimation?.cancel();
  });
  // Allow native fragment navigation to finish before framing a linked feature.
  if (document.readyState === 'complete') requestAnimationFrame(onHash);
  else window.addEventListener('load', () => requestAnimationFrame(onHash), { once: true });
}
initializeTree();
