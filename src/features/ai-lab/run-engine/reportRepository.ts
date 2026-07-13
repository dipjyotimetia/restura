import type { AiLabReportEnvelope } from './reportEnvelope';
import { setDexieStorageItemStrict } from '@/lib/shared/dexie-storage';

export interface AiLabReportRepository {
  save(reports: Record<string, AiLabReportEnvelope>): Promise<void>;
}

export const aiLabReportRepository: AiLabReportRepository = {
  save: (reports) => setDexieStorageItemStrict('aiLab', 'ai-lab-run-reports', reports),
};
