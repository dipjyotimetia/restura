import { existsSync } from 'node:fs';
import { cancel, confirm, intro, isCancel, multiselect, outro, text } from '@clack/prompts';
import type { RunOpts } from '../commands/run.js';

/**
 * Interactive launcher for `restura run`. Invoked only in a TTY when the
 * collection argument is omitted (a missing collection in CI errors instead —
 * see `executeRun`). Collects the few options worth asking for and returns a
 * partial {@link RunOpts} that the caller merges over commander's parsed flags,
 * so flag defaults stay in one place.
 */

const FILE_REPORTERS = new Set(['json', 'junit', 'html']);

/** Unwrap a clack prompt result, exiting 130 (SIGINT convention) on cancel. */
function orCancel<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel('Run cancelled.');
    process.exit(130);
  }
  return value as T;
}

export interface WizardResult {
  collectionPath: string;
  opts: Partial<RunOpts>;
}

export async function runWizard(): Promise<WizardResult> {
  intro('restura run');

  const collectionPath = orCancel(
    await text({
      message: 'Collection — directory or bundled .yaml file',
      placeholder: './my-collection',
      validate: (v) => (v && existsSync(v.trim()) ? undefined : 'Path does not exist'),
    })
  ).trim();

  const reporters = orCancel(
    await multiselect<string>({
      message: 'Reporter(s)',
      options: [
        { value: 'tui', label: 'tui', hint: 'live dashboard' },
        { value: 'live', label: 'live', hint: 'plain lines' },
        { value: 'json', label: 'json', hint: 'writes a file' },
        { value: 'junit', label: 'junit', hint: 'writes a file' },
        { value: 'html', label: 'html', hint: 'writes a file' },
        { value: 'stats', label: 'stats', hint: 'latency percentiles' },
      ],
      initialValues: ['tui'],
      required: true,
    })
  );

  const reporterOutput: string[] = [];
  for (const r of reporters) {
    if (!FILE_REPORTERS.has(r)) continue;
    const out = orCancel(
      await text({
        message: `Output path for the ${r} reporter`,
        placeholder: r === 'junit' ? 'results.xml' : r === 'html' ? 'report.html' : 'results.json',
        validate: (v) => (v && v.trim() ? undefined : 'An output path is required'),
      })
    ).trim();
    reporterOutput.push(`${r}=${out}`);
  }

  let env: string | undefined;
  if (orCancel(await confirm({ message: 'Load an env file?', initialValue: false }))) {
    env = orCancel(
      await text({
        message: 'Env file (.json / .yaml)',
        placeholder: './env.json',
        validate: (v) => (v && existsSync(v.trim()) ? undefined : 'Path does not exist'),
      })
    ).trim();
  }

  const allowLocalhost = orCancel(
    await confirm({ message: 'Allow localhost / 127.0.0.1 targets?', initialValue: false })
  );

  outro('Starting run…');

  const opts: Partial<RunOpts> = {
    reporter: reporters.join(','),
    allowLocalhost,
    ...(reporterOutput.length > 0 ? { reporterOutput } : {}),
    ...(env ? { env } : {}),
  };
  return { collectionPath, opts };
}
