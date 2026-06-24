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
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/editor/editor.all.js';
import 'monaco-editor/esm/vs/language/json/monaco.contribution';
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution';
// The typescript *language-service* contribution above wires the worker +
// javascriptDefaults and an onLanguage('javascript') hook, but it does NOT
// register the `javascript` language id itself (unlike json, whose service
// contribution self-registers). Without this basic-language registration the
// id never exists, so the scripts editor falls back to plaintext — no
// highlighting, no worker, no IntelliSense. Register it so onLanguage fires.
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution';
import 'monaco-editor/esm/vs/language/html/monaco.contribution';
import 'monaco-editor/esm/vs/language/css/monaco.contribution';
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution';
import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

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
