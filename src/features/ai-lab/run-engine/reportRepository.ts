import { getDexieStorageItemStrict, setDexieStorageItemStrict } from '@/lib/shared/dexie-storage';
import type { AiLabReportEnvelope } from './reportEnvelope';

export interface AiLabReportRepository {
  load(): Promise<Record<string, AiLabReportEnvelope>>;
  save(reports: Record<string, AiLabReportEnvelope>): Promise<void>;
}

export const aiLabReportRepository: AiLabReportRepository = {
  async load() {
    return (
      (await getDexieStorageItemStrict<Record<string, AiLabReportEnvelope>>(
        'aiLab',
        'ai-lab-run-reports'
      )) ?? {}
    );
  },
  save: (reports) => setDexieStorageItemStrict('aiLab', 'ai-lab-run-reports', reports),
};

let activeRepository = aiLabReportRepository;

export function getAiLabReportRepository(): AiLabReportRepository {
  return activeRepository;
}

export function setAiLabReportRepositoryForTests(repository: AiLabReportRepository): void {
  activeRepository = repository;
}

export function resetAiLabReportRepositoryForTests(): void {
  activeRepository = aiLabReportRepository;
}
