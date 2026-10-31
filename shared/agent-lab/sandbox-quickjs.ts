// QuickJS-backed SandboxProvider for agent suites. Runs model-written
// JavaScript in a fresh WASM runtime per call with the same memory, stack and
// wall-clock caps as request scripts and eval script scorers, and with no host
// bridges at all: no network, no filesystem, no timers, no `pm`. Kept out of
// the agent-lab barrel so consumers that never run sandboxes don't pull in the
// QuickJS loader.
import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten';
import { getQuickJS } from 'quickjs-emscripten';
import {
  QUICKJS_MAX_EXECUTION_TIME_MS,
  QUICKJS_MAX_MEMORY_BYTES,
  QUICKJS_MAX_STACK_BYTES,
} from '../scripts/sandbox-limits';
import {
  type SandboxExecutionRequest,
  type SandboxExecutionResult,
  type SandboxProvider,
  SandboxRegistry,
} from './tools';

export const QUICKJS_SANDBOX_ID = 'quickjs';
/** Conventional `timeout(1)` exit code, so a report reads the same as a process sandbox. */
export const SANDBOX_TIMEOUT_EXIT_CODE = 124;

class BoundedText {
  private text = '';
  private bytes = 0;
  private truncated = false;

  constructor(private readonly maxBytes: number) {}

  write(chunk: string): void {
    if (this.truncated) return;
    const size = new TextEncoder().encode(chunk).byteLength;
    if (this.bytes + size <= this.maxBytes) {
      this.text += chunk;
      this.bytes += size;
      return;
    }
    // Cut on a char boundary, then mark the cut so a model never mistakes it for complete output.
    let room = this.maxBytes - this.bytes;
    for (const char of chunk) {
      const charBytes = new TextEncoder().encode(char).byteLength;
      if (charBytes > room) break;
      this.text += char;
      room -= charBytes;
    }
    this.text += '\n[output truncated]';
    this.truncated = true;
  }

  toString(): string {
    return this.text;
  }
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function formatError(dumped: unknown): string {
  if (dumped && typeof dumped === 'object') {
    const { name, message, stack } = dumped as {
      name?: unknown;
      message?: unknown;
      stack?: unknown;
    };
    const head = `${typeof name === 'string' ? name : 'Error'}: ${typeof message === 'string' ? message : formatValue(dumped)}`;
    return typeof stack === 'string' && stack.trim() ? `${head}\n${stack.trim()}` : head;
  }
  return formatValue(dumped);
}

function bindConsole(vm: QuickJSContext, stdout: BoundedText, stderr: BoundedText): void {
  const consoleObject = vm.newObject();
  const sinks: Array<[string, BoundedText]> = [
    ['log', stdout],
    ['info', stdout],
    ['debug', stdout],
    ['warn', stderr],
    ['error', stderr],
  ];
  for (const [name, sink] of sinks) {
    // Argument handles are owned (and disposed) by quickjs-emscripten after the call.
    const fn = vm.newFunction(name, (...args: QuickJSHandle[]) => {
      sink.write(`${args.map((arg) => formatValue(vm.dump(arg))).join(' ')}\n`);
    });
    vm.setProp(consoleObject, name, fn);
    fn.dispose();
  }
  vm.setProp(vm.global, 'console', consoleObject);
  consoleObject.dispose();
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Sandbox execution cancelled', 'AbortError');
}

export class QuickJsSandboxProvider implements SandboxProvider {
  readonly id = QUICKJS_SANDBOX_ID;
  readonly languages = ['javascript'] as const;
  /** No host bridges: code can only compute and print, so calls need no approval. */
  readonly permissionClass = 'read' as const;

  async execute(
    request: SandboxExecutionRequest,
    signal?: AbortSignal
  ): Promise<SandboxExecutionResult> {
    if (!/^(javascript|js)$/i.test(request.language)) {
      throw new Error(`QuickJS sandbox runs JavaScript only, not ${request.language}`);
    }
    if (request.network !== 'disabled') {
      throw new Error('QuickJS sandbox has no network access; request network "disabled"');
    }
    signal?.throwIfAborted();

    const QuickJS = await getQuickJS();
    signal?.throwIfAborted();
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(QUICKJS_MAX_MEMORY_BYTES);
    runtime.setMaxStackSize(QUICKJS_MAX_STACK_BYTES);
    const timeoutMs = Math.max(1, Math.min(request.timeoutMs, QUICKJS_MAX_EXECUTION_TIME_MS));
    const maxOutputBytes = Math.max(0, request.maxOutputBytes);
    const stdout = new BoundedText(maxOutputBytes);
    const stderr = new BoundedText(maxOutputBytes);
    let deadline = Number.POSITIVE_INFINITY;
    let interrupt: 'timeout' | 'aborted' | undefined;
    runtime.setInterruptHandler(() => {
      if (signal?.aborted) interrupt = 'aborted';
      else if (Date.now() > deadline) interrupt = 'timeout';
      return interrupt !== undefined;
    });

    const vm = runtime.newContext();
    try {
      bindConsole(vm, stdout, stderr);
      // Read-only inputs; JSON round-trip keeps host objects out of the VM.
      const files = vm.evalCode(
        `globalThis.files = Object.freeze(JSON.parse(${JSON.stringify(JSON.stringify(request.files ?? {}))}));`
      );
      vm.unwrapResult(files).dispose();

      deadline = Date.now() + timeoutMs;
      const result = vm.evalCode(request.code, 'sandbox.js');
      let failure: unknown;
      if (result.error) {
        failure = vm.dump(result.error);
        result.error.dispose();
      } else {
        result.value.dispose();
        // Drain promise jobs (async functions, .then chains) under the same deadline.
        const jobs = runtime.executePendingJobs();
        if (jobs.error) {
          failure = jobs.error.context.dump(jobs.error);
          jobs.error.dispose();
        }
      }

      if (interrupt === 'aborted' && signal) throw abortError(signal);
      if (interrupt === 'timeout') {
        stderr.write(`Sandbox timed out after ${timeoutMs} ms\n`);
        return result_(SANDBOX_TIMEOUT_EXIT_CODE, stdout, stderr);
      }
      if (failure !== undefined) {
        stderr.write(`${formatError(failure)}\n`);
        return result_(1, stdout, stderr);
      }
      return result_(0, stdout, stderr);
    } finally {
      vm.dispose();
      runtime.dispose();
    }
  }
}

function result_(
  exitCode: number,
  stdout: BoundedText,
  stderr: BoundedText
): SandboxExecutionResult {
  return { exitCode, stdout: stdout.toString(), stderr: stderr.toString() };
}

/** The sandboxes every Restura agent runtime registers (desktop and CLI). */
export function createDefaultSandboxRegistry(): SandboxRegistry {
  return new SandboxRegistry([new QuickJsSandboxProvider()]);
}
