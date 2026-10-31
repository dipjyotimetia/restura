/**
 * The Collection run sequencer: decides what runs next. Iterations, data rows,
 * bail, delay, `pm.execution.setNextRequest` jumps and the jump cap live here;
 * how one Request is sent and how its result is recorded belong to the host
 * (the app's `collectionRunner.ts`, the CLI's `runner.ts`).
 *
 * The hosts differ on purpose in a few sequencing details (delay placement,
 * abort, whether a skipped Request honours a bad jump). Each is an explicit
 * option or per-step field below, so a host states which behaviour it has.
 */

/**
 * Per-iteration cap on `setNextRequest` jumps, so a buggy loop cannot hang the
 * run. Newman errors at about the same count.
 */
export const MAX_NEXT_REQUEST_JUMPS = 1000;

export type IterationRow = Record<string, string>;

/** `undefined`: advance linearly. `null`: end the iteration. A string: jump by name. */
export type NextRequest = string | null | undefined;

/**
 * The rows to iterate: one per data row when there are any, otherwise `repeat`
 * empty rows. A non-finite or sub-1 `repeat` still runs once. A non-negative
 * `maxIterations` then caps the result (0 runs nothing).
 */
export function resolveIterationRows(input: {
  dataRows?: readonly IterationRow[] | undefined;
  repeat?: number | undefined;
  maxIterations?: number | undefined;
}): readonly IterationRow[] {
  const { dataRows, repeat = 1, maxIterations } = input;
  const count = Number.isFinite(repeat) ? Math.max(1, Math.floor(repeat)) : 1;
  const rows: readonly IterationRow[] =
    dataRows && dataRows.length > 0 ? dataRows : Array.from({ length: count }, () => ({}));
  return maxIterations !== undefined && maxIterations >= 0 ? rows.slice(0, maxIterations) : rows;
}

/**
 * `pm.execution.setNextRequest` across both script phases. The test phase wins
 * when its `nextRequest` is present, even as an explicit null (`??` would mask
 * that), then the pre-request phase.
 */
export function pickNextRequest(
  testExecution: { nextRequest?: string | null | undefined } | undefined,
  preRequestExecution: { nextRequest?: string | null | undefined } | undefined
): NextRequest {
  if (testExecution && 'nextRequest' in testExecution) return testExecution.nextRequest;
  if (preRequestExecution && 'nextRequest' in preRequestExecution) {
    return preRequestExecution.nextRequest;
  }
  return undefined;
}

/** What the host reports back after one step. */
export interface StepOutcome {
  /** Counts toward `stopOnFailure`. */
  failed: boolean;
  /** The Request actually went out. Drives delay; a skipped or blocked item is not sent. */
  sent: boolean;
  next?: NextRequest;
  /**
   * What a bad jump does. `report` (default): call `onFlowError` and end the
   * iteration. `ignore`: an unknown name advances linearly and the jump cap
   * ends the iteration, both without an error.
   */
  badJump?: 'report' | 'ignore' | undefined;
}

/** The host's scope for one iteration. Per-iteration variable layers live in its closure. */
export interface IterationHost<Item> {
  /** Before the step, and before a `before-step` delay. */
  onStart(item: Item): void | Promise<void>;
  step(item: Item): Promise<StepOutcome>;
  /** A reported bad jump: `item` is the Request that asked for it. Never counts toward bail. */
  onFlowError(item: Item, message: string): void;
  /** The iteration ran to its end. Not called when the run bails or aborts. */
  onEnd?(): void;
}

export type DelayPlacement =
  /** After each sent item that did not bail, including the last. */
  | 'after-sent'
  /** After `onStart` of every item (skipped ones too) once anything has been sent. */
  | 'before-step-once-sent';

export interface SequencePlan<Item> {
  items: readonly Item[];
  /** Jump targets: first match wins, and an empty name is unreachable. */
  nameOf(item: Item): string | undefined;
  rows: readonly IterationRow[];
  stopOnFailure: boolean;
  delayMs?: number | undefined;
  delayPlacement: DelayPlacement;
  /** Checked before each item; an in-flight step and its follow-up jump still finish. */
  signal?: AbortSignal | undefined;
  /** Replaces the abort-aware timer in tests. */
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
}

export interface SequenceResult {
  /** A failed step stopped the run under `stopOnFailure`. */
  bailed: boolean;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function sequenceCollectionRun<Item>(
  plan: SequencePlan<Item>,
  beginIteration: (iteration: number, row: IterationRow) => IterationHost<Item>
): Promise<SequenceResult> {
  const { items, rows, stopOnFailure, delayPlacement, signal, sleep = abortableSleep } = plan;
  const delayMs = plan.delayMs ?? 0;

  const indexByName = new Map<string, number>();
  for (const [index, item] of items.entries()) {
    const name = plan.nameOf(item);
    if (name && !indexByName.has(name)) indexByName.set(name, index);
  }

  let sentAny = false;

  for (const [iteration, row] of rows.entries()) {
    const host = beginIteration(iteration, row);
    let jumps = 0;
    let index = 0;

    while (index < items.length) {
      const item = items[index];
      if (item === undefined) break;
      if (signal?.aborted) return { bailed: false };

      await host.onStart(item);
      if (delayPlacement === 'before-step-once-sent' && sentAny && delayMs > 0) {
        await sleep(delayMs, signal);
      }

      const outcome = await host.step(item);
      if (outcome.sent) sentAny = true;
      if (outcome.failed && stopOnFailure) return { bailed: true };
      if (delayPlacement === 'after-sent' && outcome.sent && delayMs > 0) {
        await sleep(delayMs, signal);
      }

      const { next } = outcome;
      if (next === null) break;
      if (typeof next !== 'string') {
        index++;
        continue;
      }

      const reportBadJump = outcome.badJump !== 'ignore';
      const target = indexByName.get(next);
      if (target === undefined) {
        if (reportBadJump) {
          host.onFlowError(
            item,
            `pm.execution.setNextRequest("${next}"): no runnable with that name`
          );
          break;
        }
        index++;
        continue;
      }
      if (++jumps > MAX_NEXT_REQUEST_JUMPS) {
        if (reportBadJump) {
          host.onFlowError(
            item,
            `pm.execution.setNextRequest jump limit (${MAX_NEXT_REQUEST_JUMPS}) exceeded`
          );
        }
        break;
      }
      index = target;
    }

    host.onEnd?.();
  }

  return { bailed: false };
}
