/**
 * Startup features (IPC handlers, protocol stacks) register one at a time.
 * A throw while loading or initialising a feature is reported and skipped.
 * The rest of the app keeps running. Callers must log the failure and surface
 * it; this module does not swallow it.
 */

export interface FeatureFailure {
  feature: string;
  message: string;
  stack?: string;
}

export interface RunningFeature {
  name: string;
  stop?: () => void | Promise<void>;
}

export interface StartupFeature {
  name: string;
  /** Register the feature. Return a disposer, or nothing. */
  start: () => void | (() => void | Promise<void>);
}

export function failureFrom(feature: string, err: unknown): FeatureFailure {
  if (err instanceof Error) {
    return { feature, message: err.message, ...(err.stack ? { stack: err.stack } : {}) };
  }
  return { feature, message: String(err) };
}

/** Run each feature. A throw skips that feature and is handed to `onFailure`. */
export function startFeatures(
  features: readonly StartupFeature[],
  onFailure: (failure: FeatureFailure) => void
): RunningFeature[] {
  const running: RunningFeature[] = [];
  for (const feature of features) {
    try {
      const stop = feature.start();
      running.push(
        typeof stop === 'function' ? { name: feature.name, stop } : { name: feature.name }
      );
    } catch (err) {
      onFailure(failureFrom(feature.name, err));
    }
  }
  return running;
}

export function featureFailureDialog(
  failures: readonly FeatureFailure[],
  logFile: string
): { title: string; body: string } {
  return {
    title: 'Restura started with some features unavailable',
    body: [
      'Restura is open, but these features failed to load and are turned off:',
      '',
      ...failures.map((failure) => `- ${failure.feature}: ${failure.message}`),
      '',
      'Details were saved to:',
      logFile,
    ].join('\n'),
  };
}

export function mainProcessErrorDialog(
  message: string,
  logFile: string
): { title: string; body: string } {
  return {
    title: 'Restura hit an unexpected error',
    body: [
      'Something went wrong in the desktop app. Restura will try to keep running.',
      '',
      message,
      '',
      'Details were saved to:',
      logFile,
    ].join('\n'),
  };
}
