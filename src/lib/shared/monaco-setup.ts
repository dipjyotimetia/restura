// Self-host Monaco. Without this, @monaco-editor/react defaults to fetching
// monaco-editor from jsdelivr at runtime, which stalls forever under offline
// use, ad-blockers, corporate firewalls, or Electron file:// renderers.
//
// Imported as a side effect from CodeEditor.tsx (which is itself lazy-loaded),
// so monaco-editor ends up in the CodeEditor chunk — never the main bundle.

// Curated Monaco import. The convenience `monaco-editor` barrel registers ~90
// basic languages (abap, apex, pgsql, solidity, …) we never surface, each its
// own lazy chunk — bloating the on-disk app and the lazy-chunk graph. We only
// ever render: json, html, css, javascript (scripts), xml, plaintext, and a
// runtime-registered graphql (see registerGraphQLLanguage). Import just those.
//
//   - editor.api    → the Monaco API surface (no language/feature contributions)
//   - editor.all    → all editor UI features (find, suggest, folding, hover,
//                     bracket matching, context menu, …) — feature parity with
//                     the barrel; only languages are trimmed.
//   - language/*    → worker-backed services for json / ts+js / html / css
//   - basic xml     → tokenizer-only highlighting for xml (no language service)
//
/* eslint-disable import/order -- the imports below are hand-ordered: the
   side-effect language contributions must register in this exact sequence
   (see the inline notes), so import/order's alphabetical grouping is wrong. */
import * as monaco from 'monaco-editor/editor';
// Core API-client editing surface. `features/register.all` also bundles
// diffing, rename, CodeLens, reference search and other IDE-only features.
import 'monaco-editor/features/bracketMatching/register';
import 'monaco-editor/features/caretOperations/register';
import 'monaco-editor/features/clipboard/register';
import 'monaco-editor/features/codeEditor/register';
import 'monaco-editor/features/contextmenu/register';
import 'monaco-editor/features/cursorUndo/register';
import 'monaco-editor/features/find/register';
import 'monaco-editor/features/folding/register';
import 'monaco-editor/features/format/register';
import 'monaco-editor/features/gotoError/register';
import 'monaco-editor/features/hover/register';
import 'monaco-editor/features/linesOperations/register';
import 'monaco-editor/features/multicursor/register';
import 'monaco-editor/features/readOnlyMessage/register';
import 'monaco-editor/features/snippet/register';
// Monaco 0.56's public suggest entry registers inline suggestions only. The
// API editor also needs the standard Ctrl/Cmd+Space suggestion controller.
import 'monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController.js';
import 'monaco-editor/features/suggest/register';
import 'monaco-editor/features/unicodeHighlighter/register';
import 'monaco-editor/features/wordHighlighter/register';
import 'monaco-editor/features/wordOperations/register';
// Monaco 0.56 language-service workers register their shared editor
// contributions internally. Register the two standalone services those
// contributions require without opting into their UI features.
import 'monaco-editor/esm/vs/editor/contrib/codelens/browser/codeLensCache.js';
import 'monaco-editor/esm/vs/editor/common/services/treeViewsDndService.js';
import { jsonDefaults } from 'monaco-editor/languages/features/json/register';
import 'monaco-editor/languages/features/typescript/register';
// The typescript *language-service* contribution above wires the worker +
// javascriptDefaults and an onLanguage('javascript') hook, but it does NOT
// register the `javascript` language id itself (unlike json, whose service
// contribution self-registers). Without this basic-language registration the
// id never exists, so the scripts editor falls back to plaintext — no
// highlighting, no worker, no IntelliSense. Register it so onLanguage fires.
import 'monaco-editor/languages/definitions/javascript/register';
import 'monaco-editor/languages/features/html/register';
import 'monaco-editor/languages/features/css/register';
import 'monaco-editor/languages/definitions/xml/register';
import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker.js?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker.js?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker.js?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker.js?worker';

export { jsonDefaults };

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case 'json':
        return new JsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker();
      case 'typescript':
      case 'javascript':
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};

loader.config({ monaco });

monaco.editor.defineTheme('restura-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    // Aligned to the Spatial Depth dark palette (--sp-code / --sp-surface).
    'editor.background': '#0c0e13',
    'editorGutter.background': '#0c0e13',
    'minimap.background': '#0c0e13',
    'editor.lineHighlightBackground': '#ffffff08',
    'editorLineNumber.foreground': '#eef1f95c',
    'editorLineNumber.activeForeground': '#eef1f999',
    'editor.selectionBackground': '#2e91ff33',
    'editorWidget.background': '#14171e',
    'editorSuggestWidget.background': '#14171e',
    'input.background': '#14171e',
  },
});

monaco.editor.defineTheme('restura-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#f6f8fc',
    'editorGutter.background': '#f6f8fc',
    'minimap.background': '#f6f8fc',
    'editor.lineHighlightBackground': '#0e132008',
    'editorLineNumber.foreground': '#0e132060',
    'editorLineNumber.activeForeground': '#0e1320aa',
    'editor.selectionBackground': '#2e91ff33',
  },
});
