import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  featurePosition,
  features,
  mapHeight,
  mapWidth,
  nodeHeight,
} from '../src/data/product-tree';

const windowListeners = vi.spyOn(window, 'addEventListener');
const documentListeners = vi.spyOn(document, 'addEventListener');

const rect = (top: number, bottom: number) => ({
  top,
  bottom,
  left: 0,
  right: 1000,
  width: 1000,
  height: bottom - top,
  x: 0,
  y: top,
  toJSON: () => ({}),
});

beforeEach(async () => {
  windowListeners.mockClear();
  documentListeners.mockClear();
  vi.resetModules();
  vi.useFakeTimers();
  history.replaceState(null, '', '/tree/');
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0)
  );
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  document.body.innerHTML = `
    <button id="tree-view">Tree</button><button id="list-view">List</button>
    <button id="zoom-in"></button><button id="zoom-out"></button><button id="reset-map"></button><output id="zoom-level"></output>
    <button id="clear-search"></button><button id="clear-filters"></button><button id="theme-toggle"></button>
    <input id="feature-search"><ul id="search-results"></ul><p id="result-count"></p><div id="empty-state"></div><div id="tree-controls"></div>
    <div id="tree-viewport"><div id="tree-canvas"><svg class="connections"><g id="dependency-lines"></g></svg>
    ${features.map((feature) => `<article data-card="${feature.id}"><button data-feature="${feature.id}"></button></article>`).join('')}</div></div>
    <div id="feature-list">${features.map((feature) => `<details data-list-feature="${feature.id}"><summary>${feature.title}</summary><div class="list-detail"></div></details>`).join('')}</div>
    <section id="feature-detail" hidden><button id="close-detail"></button><h3 id="detail-title" tabindex="-1"></h3><p id="detail-description"></p><p id="detail-status"></p>
    <h3 id="detail-platform-heading"></h3><p id="detail-platforms"></p><p id="detail-planned-note"></p>
    <div id="detail-prerequisites"><ul></ul></div><div id="detail-unlocks"><ul></ul></div><a id="detail-docs"></a><button id="copy-link"></button><span id="copy-status"></span></section>`;
  const viewport = document.getElementById('tree-viewport')!;
  Object.defineProperties(viewport, { clientWidth: { value: 1000 }, clientHeight: { value: 600 } });
  viewport.getBoundingClientRect = () => rect(0, 600);
  Object.defineProperty(document.getElementById('feature-detail'), 'offsetHeight', { value: 200 });
  await import('../src/scripts/product-tree');
  vi.runAllTimers();
  document.getElementById('tree-view')!.click();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const [type, listener, options] of windowListeners.mock.calls)
    window.removeEventListener(type, listener, options);
  for (const [type, listener, options] of documentListeners.mock.calls)
    document.removeEventListener(type, listener, options);
  document.body.replaceChildren();
});

it('keeps the incoming fragment when navigating between open features', () => {
  const navigate = (id: string) => {
    history.replaceState(null, '', `/tree/#${id}`);
    window.dispatchEvent(new Event('hashchange'));
  };
  navigate('http');
  navigate('graphql');
  expect(location.hash).toBe('#graphql');
  expect(document.getElementById('detail-title')!.textContent).toBe('GraphQL');
});

it('retains keyboard focus after following a feature relationship', () => {
  document.querySelector<HTMLButtonElement>('[data-feature="har-import"]')!.click();
  const prerequisite = document.querySelector<HTMLButtonElement>('#detail-prerequisites button')!;
  prerequisite.focus();
  prerequisite.click();
  expect(document.getElementById('detail-title')!.textContent).toBe('Import & export');
  expect(document.activeElement?.id).toBe('detail-title');
});

it('frames the displaced position of a node below an expanded card', () => {
  document.querySelector<HTMLButtonElement>('[data-feature="http"]')!.click();
  const node = document.querySelector<HTMLButtonElement>('[data-feature="graphql"]')!;
  node.getBoundingClientRect = () => rect(1000, 1062);
  node.focus();
  const graphQL = features.find((feature) => feature.id === 'graphql')!;
  const scale = Math.min(1, (1000 - 52) / mapWidth, (600 - 88) / mapHeight);
  const expectedY = 300 - (featurePosition(graphQL).y + 200 + nodeHeight / 2) * scale;
  expect(document.getElementById('tree-canvas')!.style.transform).toContain(`${expectedY}px`);
});

afterAll(() => {
  windowListeners.mockRestore();
  documentListeners.mockRestore();
});
