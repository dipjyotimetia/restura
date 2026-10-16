import type { WorkerLike } from './timeline-regex';
import TimelineRegexWorker from './timeline-regex.worker?worker';

/** Browser/Electron factory — split out so tests can mock the `?worker` import. */
export function createTimelineRegexWorker(): WorkerLike {
  return new TimelineRegexWorker() as unknown as WorkerLike;
}
