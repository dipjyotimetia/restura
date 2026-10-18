import { writeFile } from 'node:fs/promises';
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {
  type McpConformanceDeps,
  type McpConformanceReport,
  type McpEra,
  type McpSampleCallMode,
  runMcpConformance,
} from '@shared/protocol/mcp-conformance';
import {
  conformanceReportToJson,
  conformanceReportToMarkdown,
} from '@shared/protocol/mcp-conformance-report';
import { validateMcpSpec } from '@shared/protocol/mcp-proxy';
import type { Command } from 'commander';
import { z } from 'zod';
import { createPinnedMcpFetchSession } from '../runner/pinnedMcpFetch.js';

const MODERN_PIN = '2026-07-28';
const GENERIC_RESULT = z.unknown();

export interface McpConformanceCommandOpts {
  transport: string;
  eras: string;
  sampleCalls: string;
  approveTool?: string[];
  header?: string[];
  headerEnv?: string[];
  format: string;
  output?: string;
  timeout: string;
  allowLocalhost: boolean;
  failOn: string;
}

export interface McpConformanceCommandDependencies {
  environment: Readonly<Record<string, string | undefined>>;
  createDeps(config: {
    url: string;
    transport: 'streamable-http' | 'http-sse';
    headers: Record<string, string>;
    allowLocalhost: boolean;
    timeoutMs: number;
  }): McpConformanceDeps & { dispose?: () => Promise<void> };
  writeFile(path: string, data: string): Promise<void>;
  stdout(text: string): void;
  stderr(text: string): void;
}

/** Per-era SDK sessions behind DNS-pinned, redirect-refusing fetch (SSRF guard). */
export function createSdkConformanceDeps(config: {
  url: string;
  transport: 'streamable-http' | 'http-sse';
  headers: Record<string, string>;
  allowLocalhost: boolean;
  timeoutMs: number;
}): McpConformanceDeps {
  return {
    async open(era: McpEra) {
      if (era === 'modern' && config.transport === 'http-sse') {
        throw new Error('The modern era is only available over streamable-http');
      }
      const pinned = createPinnedMcpFetchSession(config.allowLocalhost);
      const options = { fetch: pinned.fetch, requestInit: { headers: config.headers } };
      const transport =
        config.transport === 'streamable-http'
          ? new StreamableHTTPClientTransport(new URL(config.url), options)
          : new SSEClientTransport(new URL(config.url), options);
      const client = new Client(
        { name: 'restura-cli', version: '1.0.0' },
        {
          capabilities: {},
          versionNegotiation: { mode: era === 'legacy' ? 'legacy' : { pin: MODERN_PIN } },
        }
      );
      try {
        await client.connect(transport, { timeout: config.timeoutMs });
      } catch (error) {
        await Promise.allSettled([client.close(), pinned.dispose()]);
        throw error;
      }
      const opts = { timeout: config.timeoutMs };
      return {
        protocolVersion: client.getNegotiatedProtocolVersion() ?? '',
        serverCapabilities: client.getServerCapabilities(),
        serverInfo: client.getServerVersion(),
        request(method: string, params?: unknown): Promise<unknown> {
          switch (method) {
            case 'tools/list':
              return client.listTools(params as Parameters<Client['listTools']>[0], opts);
            case 'resources/list':
              return client.listResources(params as Parameters<Client['listResources']>[0], opts);
            case 'prompts/list':
              return client.listPrompts(params as Parameters<Client['listPrompts']>[0], opts);
            case 'tools/call':
              return client.callTool(params as Parameters<Client['callTool']>[0], opts);
            default:
              return client.request(
                { method, params } as Parameters<Client['request']>[0],
                GENERIC_RESULT,
                opts
              );
          }
        },
        async close() {
          await Promise.allSettled([client.close(), pinned.dispose()]);
        },
      };
    },
  };
}

const defaultDependencies: McpConformanceCommandDependencies = {
  environment: process.env,
  createDeps: createSdkConformanceDeps,
  writeFile: (path, data) => writeFile(path, data, 'utf8'),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

function positiveTimeout(value: string): number {
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(`--timeout expects a positive number, got: ${value}`);
  }
  return timeout;
}

function parseHeaders(
  opts: McpConformanceCommandOpts,
  environment: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const raw of opts.header ?? []) {
    const idx = raw.indexOf(':');
    if (idx <= 0) throw new Error(`--header expects "Name: value", got: ${raw}`);
    headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
  }
  for (const raw of opts.headerEnv ?? []) {
    const idx = raw.indexOf('=');
    if (idx <= 0) throw new Error(`--header-env expects "Name=ENV_VAR", got: ${raw}`);
    const name = raw.slice(0, idx).trim();
    const variable = raw.slice(idx + 1).trim();
    const value = environment[variable];
    if (value === undefined) throw new Error(`Header environment variable is not set: ${variable}`);
    headers[name] = value;
  }
  return headers;
}

function parseEras(value: string): McpEra[] {
  const eras = value
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  if (eras.length === 0 || eras.some((e) => e !== 'legacy' && e !== 'modern')) {
    throw new Error(`--eras expects a comma-separated list of legacy,modern, got: ${value}`);
  }
  return [...new Set(eras)] as McpEra[];
}

function oneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${flag} expects one of ${allowed.join(', ')}, got: ${value}`);
  }
  return value as T;
}

/** Exit 1 when the report has findings at/above `failOn`; 0 otherwise. */
export function conformanceExitCode(
  report: McpConformanceReport,
  failOn: 'error' | 'warning' | 'never'
): 0 | 1 {
  if (failOn === 'never') return 0;
  if (report.summary.errors > 0) return 1;
  return failOn === 'warning' && report.summary.warnings > 0 ? 1 : 0;
}

/**
 * `restura mcp conformance <url>`: run the shared era/conformance engine over
 * HTTP transports and print/write a Markdown or JSON report. Exits 1 when
 * findings reach `--fail-on`, 2 (via the registrar) on usage/IO errors.
 */
export async function executeMcpConformanceCommand(
  url: string,
  opts: McpConformanceCommandOpts,
  dependencies: McpConformanceCommandDependencies = defaultDependencies
): Promise<0 | 1> {
  const transport = oneOf('--transport', opts.transport, ['streamable-http', 'http-sse'] as const);
  const sampleCalls: McpSampleCallMode = oneOf('--sample-calls', opts.sampleCalls, [
    'off',
    'read-only',
    'selected',
  ] as const);
  const format = oneOf('--format', opts.format, ['markdown', 'json'] as const);
  const failOn = oneOf('--fail-on', opts.failOn, ['error', 'warning', 'never'] as const);
  const eras = parseEras(opts.eras);
  const timeoutMs = positiveTimeout(opts.timeout);
  const headers = parseHeaders(opts, dependencies.environment);
  const approvedTools = opts.approveTool ?? [];
  if (approvedTools.length > 0 && sampleCalls !== 'selected') {
    throw new Error('--approve-tool requires --sample-calls selected');
  }

  // Same SSRF preflight as the agent MCP client: scheme, credentials, metadata
  // endpoints and (unless --allow-localhost) loopback/private ranges.
  const validation = validateMcpSpec(
    {
      url,
      transport,
      ...(transport === 'http-sse' ? { postEndpoint: url } : {}),
      headers,
      jsonRpc: { id: 'conformance-preflight', method: 'initialize' },
    },
    Boolean(opts.allowLocalhost)
  );
  if (!validation.ok) throw new Error(validation.error);

  const deps = dependencies.createDeps({
    url,
    transport,
    headers: validation.headers,
    allowLocalhost: Boolean(opts.allowLocalhost),
    timeoutMs,
  });
  const report = await runMcpConformance(deps, {
    eras,
    sampleCalls,
    approvedTools,
    target: url,
  });
  await deps.dispose?.();

  const text =
    format === 'json' ? conformanceReportToJson(report) : conformanceReportToMarkdown(report);
  if (opts.output) {
    await dependencies.writeFile(opts.output, text);
    dependencies.stderr(`Conformance report written to ${opts.output}\n`);
  } else {
    dependencies.stdout(text);
  }
  const { errors, warnings, info } = report.summary;
  dependencies.stderr(`${errors} error(s), ${warnings} warning(s), ${info} note(s)\n`);
  return conformanceExitCode(report, failOn);
}

const collect = (value: string, previous: string[] = []) => [...previous, value];

/** Register `restura mcp conformance <url>`. */
export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .description('MCP server tooling')
    .command('conformance')
    .description(
      'Connect in the legacy and modern MCP protocol eras, check conformance, and diff them'
    )
    .argument('<url>', 'MCP server URL (HTTP transports only)')
    .option('--transport <t>', 'streamable-http | http-sse', 'streamable-http')
    .option('--eras <list>', 'Comma-separated eras to test: legacy,modern', 'legacy,modern')
    .option(
      '--sample-calls <mode>',
      'off | read-only (call readOnlyHint tools) | selected (also --approve-tool)',
      'off'
    )
    .option(
      '--approve-tool <name>',
      'Non-read-only tool you approve calling (repeatable; destructive tools are never called)',
      collect
    )
    .option('-H, --header <header>', 'Request header "Name: value" (repeatable)', collect)
    .option(
      '--header-env <spec>',
      'Request header from an environment variable, "Name=ENV_VAR" (repeatable; keeps secrets out of argv)',
      collect
    )
    .option('--format <f>', 'markdown | json', 'markdown')
    .option('--output <file>', 'Write the report to a file instead of stdout')
    .option('--timeout <ms>', 'Per-request timeout', '30000')
    .option('--allow-localhost', 'Permit localhost / 127.0.0.1 targets (off by default)', false)
    .option('--fail-on <level>', 'Exit 1 on: error | warning | never', 'error')
    .action(async (url: string, opts: McpConformanceCommandOpts) => {
      try {
        process.exitCode = await executeMcpConformanceCommand(url, opts);
      } catch (error) {
        console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
      }
    });
}
