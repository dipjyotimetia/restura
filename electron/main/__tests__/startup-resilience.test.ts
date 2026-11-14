import { describe, expect, it } from 'vitest';
import {
  featureFailureDialog,
  mainProcessErrorDialog,
  startFeatures,
} from '../lifecycle/feature-loader';
import { rendererGoneAction } from '../lifecycle/renderer-recovery';

describe('startFeatures', () => {
  it('keeps later features running when one fails to load', () => {
    const failures: string[] = [];
    const running = startFeatures(
      [
        {
          name: 'http',
          start: () => {
            /* registered */
          },
        },
        {
          name: 'mcp-control',
          start: () => {
            throw new Error("Cannot find module '@modelcontextprotocol/node'");
          },
        },
        {
          name: 'kafka',
          start: () => () => {
            /* dispose */
          },
        },
      ],
      (failure) => failures.push(failure.feature)
    );

    expect(failures).toEqual(['mcp-control']);
    expect(running.map((feature) => feature.name)).toEqual(['http', 'kafka']);
    expect(running[1]?.stop).toEqual(expect.any(Function));
  });
});

describe('startup dialogs', () => {
  it('names the failed feature and the log file', () => {
    const text = featureFailureDialog(
      [{ feature: 'mcp-control', message: "Cannot find module '@modelcontextprotocol/node'" }],
      '/Users/me/Library/Logs/Restura/main.log'
    );
    expect(text.title).toMatch(/features unavailable/);
    expect(text.body).toContain('mcp-control');
    expect(text.body).toContain('@modelcontextprotocol/node');
    expect(text.body).toContain('/Users/me/Library/Logs/Restura/main.log');
  });

  it('describes an unexpected main-process error without the raw Electron title', () => {
    const text = mainProcessErrorDialog('boom', '/tmp/main.log');
    expect(text.title).not.toMatch(/JavaScript error occurred/);
    expect(text.body).toContain('keep running');
    expect(text.body).toContain('boom');
    expect(text.body).toContain('/tmp/main.log');
  });
});

describe('rendererGoneAction', () => {
  it('ignores a clean exit, reloads the first crash, and stops after that', () => {
    expect(rendererGoneAction(0, 'clean-exit')).toBe('ignore');
    expect(rendererGoneAction(0, 'crashed')).toBe('reload');
    expect(rendererGoneAction(0, 'oom')).toBe('reload');
    expect(rendererGoneAction(1, 'crashed')).toBe('give-up');
  });
});
