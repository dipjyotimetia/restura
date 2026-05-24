// Self-host Monaco. Without this, @monaco-editor/react defaults to fetching
// monaco-editor from jsdelivr at runtime, which stalls forever under offline
// use, ad-blockers, corporate firewalls, or Electron file:// renderers.
//
// Imported as a side effect from CodeEditor.tsx (which is itself lazy-loaded),
// so monaco-editor ends up in the CodeEditor chunk — never the main bundle.

import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
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
    'editor.background': '#0a0d14',
    'editorGutter.background': '#0a0d14',
    'minimap.background': '#0a0d14',
    'editor.lineHighlightBackground': '#ffffff08',
    'editorLineNumber.foreground': '#eef1f95c',
    'editorLineNumber.activeForeground': '#eef1f999',
    'editor.selectionBackground': '#4d9fff33',
    'editorWidget.background': '#0e1120',
    'editorSuggestWidget.background': '#0e1120',
    'input.background': '#0e1120',
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
    'editor.selectionBackground': '#4d9fff33',
  },
});
