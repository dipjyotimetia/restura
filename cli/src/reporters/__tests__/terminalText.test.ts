import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoadedRequest } from '../../runner/collectionLoader';
import { formatImportReport } from '../../runner/postmanImport';
import { formatRequestLine } from '../format';
import { LiveReporter } from '../live';
import { renderFrame } from '../tui';
import type { RequestRunResult } from '../types';

/**
 * Collection and request names and error messages come from files and
 * servers: printed raw, an ESC / OSC / C1 sequence would drive the terminal
 * (clear the screen, plant a hyperlink, retitle the window). Only the
 * reporters' own SGR colour codes may reach it.
 */

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI_C1 = String.fromCharCode(0x9b);
const HOSTILE = `evil${ESC}]8;;https://x.test${BEL}link${ESC}]8;;${BEL}${ESC}[2J${ESC}]0;title${BEL}\rX${CSI_C1}6n`;

const OWN_SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
// Every C0 control except \n, DEL and every C1 control.
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(9)}${String.fromCharCode(0x0b)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}]`
);

function expectTerminalSafe(text: string): void {
  expect(text.replace(OWN_SGR, '')).not.toMatch(CONTROL);
}

function result(name: string, errorMessage?: string): RequestRunResult {
  const request: LoadedRequest = {
    relativePath: 'r',
    folderPath: [],
    type: 'http',
    request: {
      id: 'r',
      name,
      type: 'http',
      method: 'GET',
      url: 'https://api.test/x',
      headers: [],
      params: [],
      body: { type: 'none' },
      auth: { type: 'none' },
    },
  };
  return {
    request,
    status: errorMessage ? 0 : 200,
    passed: !errorMessage,
    durationMs: 3,
    bodyBytes: 0,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reporters strip terminal control sequences from untrusted text', () => {
  it('format: request name and error message', () => {
    const line = formatRequestLine(result(HOSTILE, `upstream said ${HOSTILE}`));
    expectTerminalSafe(line);
    expect(line).toContain('evil');
    expect(line).toContain('upstream said');
  });

  it('tui: collection title and row names', () => {
    const frame = renderFrame(
      {
        collectionName: HOSTILE,
        total: 1,
        rows: [{ method: 'GET', name: HOSTILE, outcome: 'pass', status: 200, durationMs: 1 }],
        current: { method: 'GET', name: HOSTILE, outcome: 'running' },
        spinnerFrame: 0,
        done: false,
      },
      { width: 120, maxRows: 5 }
    );
    expectTerminalSafe(frame);
  });

  it('live: the collection name in the start line', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const reporter = new LiveReporter();
    reporter.onStart({ collectionName: HOSTILE, collectionDir: '/c', startedAt: 0 });
    reporter.onRequestComplete(result(HOSTILE, HOSTILE));
    for (const [text] of log.mock.calls) expectTerminalSafe(String(text));
  });

  it('postman import report: names, auth types and details', () => {
    const text = formatImportReport({
      sourceVersion: '3.0',
      warnings: [
        { kind: 'unsupported-auth', authType: HOSTILE, requestName: HOSTILE },
        { kind: 'unmodelled-construct', construct: HOSTILE, detail: HOSTILE },
      ],
      skippedSymlinks: [HOSTILE],
    });
    expectTerminalSafe(text);
    expect(text).toContain('evil');
  });
});

describe('LiveReporter script console lines', () => {
  it('token-scrubs console output before it reaches stderr (CI logs)', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    new LiveReporter().onRequestComplete({
      ...result('r'),
      consoleLogs: [{ phase: 'test', type: 'log', message: `Authorization: Bearer ${jwt}` }],
    });
    const out = writes.join('');
    expect(out).toContain('[test log]');
    expect(out).not.toContain(jwt);
  });
});
