/** Per-collection and per-environment agent access (Settings → MCP Server). */

import {
  type CollectionConsentLevel,
  type EnvironmentConsentLevel,
  getConsentLevel,
  getEnvironmentConsentLevel,
  setCollectionConsent,
  setEnvironmentConsent,
  setEnvironmentExecutable,
} from '@shared/mcp-server/consent';
import type { McpServerSettings } from '@shared/mcp-server/settings';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { updateMcpConsentFresh } from '../../lib/settings';
import { LevelSelect, type SettingsPrimitives } from './primitives';

const COLLECTION_LEVELS: Array<{ value: CollectionConsentLevel; label: string }> = [
  { value: 'hidden', label: 'Hidden' },
  { value: 'read-only', label: 'Read' },
  { value: 'edit', label: 'Read & edit' },
  { value: 'full', label: 'Full (send)' },
];

const ENVIRONMENT_LEVELS: Array<{ value: EnvironmentConsentLevel; label: string }> = [
  { value: 'hidden', label: 'Hidden' },
  { value: 'read-only', label: 'Read' },
  { value: 'edit', label: 'Read & edit' },
];

export function AccessGroups({
  settings,
  Group,
  Row,
}: SettingsPrimitives & { settings: McpServerSettings }) {
  const collections = useCollectionStore((s) => s.collections);
  const environments = useEnvironmentStore((s) => s.environments);
  return (
    <>
      <Group label="Collections agents may use">
        <Row
          label="New collections"
          hint="Access for collections without their own setting."
          control={
            <LevelSelect
              value={settings.consent.defaultLevel}
              options={COLLECTION_LEVELS}
              ariaLabel="Default access for collections"
              onChange={(level) =>
                void updateMcpConsentFresh((c) => ({ ...c, defaultLevel: level }))
              }
            />
          }
        />
        {collections.map((collection) => (
          <Row
            key={collection.id}
            label={collection.name}
            control={
              <LevelSelect
                value={getConsentLevel(settings.consent, collection.id)}
                options={COLLECTION_LEVELS}
                ariaLabel={`Agent access for collection ${collection.name}`}
                onChange={(level) =>
                  void updateMcpConsentFresh((c) => setCollectionConsent(c, collection.id, level))
                }
              />
            }
          />
        ))}
      </Group>

      <Group label="Environments agents may use">
        {environments.length === 0 && (
          <div className="py-3 text-sp-12 text-sp-muted">No environments yet.</div>
        )}
        {environments.map((environment) => {
          const executable = settings.consent.executableEnvironments?.[environment.id] === true;
          return (
            <Row
              key={environment.id}
              label={environment.name}
              hint={
                <label className="inline-flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={executable}
                    aria-label={`Agents may send with ${environment.name}`}
                    onChange={(e) =>
                      void updateMcpConsentFresh((c) =>
                        setEnvironmentExecutable(c, environment.id, e.target.checked)
                      )
                    }
                  />
                  Agents may send with this environment
                  {executable && /prod/i.test(environment.name) ? (
                    <span className="text-amber-600 dark:text-amber-400">
                      {' '}
                      — looks like production
                    </span>
                  ) : null}
                </label>
              }
              control={
                <LevelSelect
                  value={getEnvironmentConsentLevel(settings.consent, environment.id)}
                  options={ENVIRONMENT_LEVELS}
                  ariaLabel={`Agent access for environment ${environment.name}`}
                  onChange={(level) =>
                    void updateMcpConsentFresh((c) =>
                      setEnvironmentConsent(c, environment.id, level)
                    )
                  }
                />
              }
            />
          );
        })}
      </Group>
    </>
  );
}
