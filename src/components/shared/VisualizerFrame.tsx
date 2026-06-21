/**
 * Sandboxed iframe that renders a Postman-style `pm.visualizer.set` payload.
 *
 * Security model:
 *  - The iframe uses `sandbox="allow-scripts"` ONLY. Combining
 *    `allow-scripts` with `allow-same-origin` is forbidden by the HTML5
 *    spec for sandbox boundaries — together they defeat the isolation —
 *    so we never set both.
 *  - The composed HTML carries a strict CSP that blocks every outbound
 *    network attempt (`default-src 'none'`), permits only inline
 *    scripts/styles, and allows `data:` images. A template that injects
 *    `<img src=x onerror=fetch(...)>` cannot reach attacker-controlled
 *    hosts.
 *  - `srcDoc` length is capped at 1MB; oversized payloads render an
 *    explanatory placeholder instead of refusing silently.
 *
 * Postman-compatibility:
 *  - Inside the iframe we synthesise a tiny `pm` object exposing
 *    `getData() → JSON-parsed data`. That mirrors what Postman's
 *    visualizer harness provides to template authors.
 */
import { useMemo } from 'react';

interface VisualizerFrameProps {
  template: string;
  data: unknown;
  /** Optional class for sizing — the iframe inherits height from its parent. */
  className?: string;
}

const MAX_SRCDOC_BYTES = 1024 * 1024;

const CSP =
  "default-src 'none'; " +
  "script-src 'unsafe-inline'; " +
  "style-src 'unsafe-inline'; " +
  'img-src data:; ' +
  'font-src data:; ' +
  "form-action 'none'; " +
  "frame-ancestors 'none'; " +
  "base-uri 'none';";

/**
 * Build the iframe srcDoc. The pm-shim runs BEFORE the user's template
 * so any inline `<script>` in the template can already call `pm.getData()`.
 * `data` is JSON-stringified and embedded as a JS literal, so the shim
 * hands the template back the original value (a string stays a string,
 * not a quoted-string).
 */
function composeSrcDoc(template: string, data: unknown): string {
  let dataJson: string;
  try {
    dataJson = JSON.stringify(data);
  } catch {
    dataJson = 'null';
  }
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>
  html, body { margin: 0; padding: 12px; font-family: system-ui, sans-serif; color: var(--vis-fg, #111); background: var(--vis-bg, #fff); }
</style>
<script>
  // Postman-shape pm.visualizer harness — exposes getData() / __data__.
  (function () {
    var __raw = ${dataJson};
    window.pm = window.pm || {};
    window.pm.getData = function () { return __raw; };
  })();
</script>
</head><body>
${template}
</body></html>`;
}

export function VisualizerFrame({ template, data, className }: VisualizerFrameProps) {
  const srcDoc = useMemo(() => composeSrcDoc(template ?? '', data), [template, data]);

  if (srcDoc.length > MAX_SRCDOC_BYTES) {
    return (
      <div className={`p-4 text-sm text-muted-foreground ${className ?? ''}`}>
        Visualization payload exceeds the 1 MB safety cap; rendering skipped.
      </div>
    );
  }

  return (
    <iframe
      // NEVER add `allow-same-origin` — combining it with `allow-scripts`
      // defeats the sandbox. This is the load-bearing security boundary.
      sandbox="allow-scripts"
      title="Visualization"
      srcDoc={srcDoc}
      className={`w-full h-full border-0 ${className ?? ''}`}
    />
  );
}
