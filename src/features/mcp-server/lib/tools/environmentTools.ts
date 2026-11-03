/**
 * Environment edit / destructive tools. Secrets are never written by the
 * agent: `request_secret_variable` has the user type the value.
 */

import {
  canCreateEnvironment,
  canEditEnvironment,
  setEnvironmentConsent,
} from '@shared/mcp-server/consent';
import type { ControlToolInput } from '@shared/mcp-server/control-tools';
import { v4 as uuidv4 } from 'uuid';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import type { Environment } from '@/types';
import { containsPlaceholder } from '../savedRedaction';
import {
  editableEnvironment,
  fingerprint,
  grant,
  restoreEnvironment,
  UndoConflictError,
} from './editShared';
import { clip, refuse, SETTINGS_HINT, type ToolImpl } from './types';

const createEnvironment: ToolImpl<ControlToolInput<'create_environment'>> = (input, env) => {
  if (
    !canCreateEnvironment(
      env.settings.consent,
      new Set(useEnvironmentStore.getState().environments.map((e) => e.id))
    )
  ) {
    return refuse(
      `Creating environments is not allowed: no environment is shared for editing. ${SETTINGS_HINT}`
    );
  }
  const variables = input.variables ?? [];
  if (containsPlaceholder(variables.map((v) => v.value))) {
    return refuse(
      'A variable value is a redaction placeholder such as "(secret)". Leave secrets out and use request_secret_variable.'
    );
  }
  return {
    title: `Create environment “${input.name}”`,
    details: variables.length > 0 ? [`Variables: ${variables.map((v) => v.key).join(', ')}`] : [],
    run: () => {
      const store = useEnvironmentStore.getState();
      const environment: Environment = {
        ...store.createNewEnvironment(input.name),
        variables: variables.map((v) => ({
          id: uuidv4(),
          key: v.key,
          value: v.value,
          enabled: true,
        })),
      };
      store.addEnvironment(environment);
      grant((c) => setEnvironmentConsent(c, environment.id, 'edit'));
      return {
        data: { environmentId: environment.id, name: environment.name },
        summary: `Created environment “${environment.name}”`,
        undo: restoreEnvironment(undefined, environment.id),
      };
    },
  };
};

const setEnvironmentVariable: ToolImpl<ControlToolInput<'set_environment_variable'>> = (
  input,
  env
) => {
  const environment = editableEnvironment(input.environmentId, env);
  if ('refused' in environment) return environment;
  if (containsPlaceholder(input.value)) {
    return refuse(
      'The value is a redaction placeholder such as "(secret)", not a real value. Use request_secret_variable for secrets.'
    );
  }
  const existing = environment.variables.find((v) => v.key === input.key);
  if (existing?.secret || existing?.secretRef) {
    return refuse(
      `“${input.key}” is a secret variable. Use request_secret_variable so the user types the value.`
    );
  }
  return {
    title: `${existing ? 'Update' : 'Add'} variable “${input.key}”`,
    details: [`In environment “${environment.name}”`, `Value: ${clip(input.value)}`],
    fingerprint: fingerprint(environment),
    run: () => {
      const snapshot = structuredClone(environment);
      const store = useEnvironmentStore.getState();
      if (existing) {
        store.updateVariable(environment.id, existing.id, {
          value: input.value,
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        });
      } else {
        store.addVariable(environment.id, {
          id: uuidv4(),
          key: input.key,
          value: input.value,
          enabled: input.enabled ?? true,
        });
      }
      return {
        data: { environmentId: environment.id, key: input.key },
        summary: `Set “${input.key}” in “${environment.name}”`,
        undo: restoreEnvironment(snapshot),
      };
    },
  };
};

const requestSecretVariable: ToolImpl<ControlToolInput<'request_secret_variable'>> = (
  input,
  env
) => {
  const environment = editableEnvironment(input.environmentId, env);
  if ('refused' in environment) return environment;
  const existing = environment.variables.find((v) => v.key === input.key);
  if (existing?.secretRef) {
    return refuse(
      `“${input.key}” is stored in the desktop keychain; the user manages it in Restura.`
    );
  }
  return {
    title: `Secret “${input.key}” for “${environment.name}”`,
    details: [input.reason],
    secretPrompt: { environmentName: environment.name, key: input.key, reason: input.reason },
    run: ({ secretValue }) => {
      if (secretValue === undefined) throw new Error('No value was entered.');
      const snapshot = structuredClone(environment);
      const store = useEnvironmentStore.getState();
      if (existing) {
        store.updateVariable(environment.id, existing.id, {
          value: secretValue,
          secret: true,
          enabled: true,
        });
      } else {
        store.addVariable(environment.id, {
          id: uuidv4(),
          key: input.key,
          value: secretValue,
          enabled: true,
          secret: true,
        });
      }
      return {
        // The value never goes back to the agent.
        data: {
          environmentId: environment.id,
          key: input.key,
          set: true,
          reference: `{{${input.key}}}`,
        },
        summary: `User set secret “${input.key}” in “${environment.name}”`,
        undo: restoreEnvironment(snapshot),
      };
    },
  };
};

const setActiveEnvironment: ToolImpl<ControlToolInput<'set_active_environment'>> = (input, env) => {
  const store = useEnvironmentStore.getState();
  const target = input.environmentId
    ? store.environments.find((e) => e.id === input.environmentId)
    : undefined;
  // Switching changes which credentials the user's own next Send uses, so it
  // needs edit access — on the target, and on the environment it replaces.
  if (input.environmentId && (!target || !canEditEnvironment(env.settings.consent, target.id))) {
    return refuse(
      `Environment not found or not shared for editing: ${input.environmentId}. ${SETTINGS_HINT}`
    );
  }
  const active = store.activeEnvironmentId;
  if (active && active !== target?.id && !canEditEnvironment(env.settings.consent, active)) {
    return refuse(
      `The active environment is not shared for editing, so it cannot be switched. ${SETTINGS_HINT}`
    );
  }
  return {
    title: target ? `Switch to environment “${target.name}”` : 'Clear the active environment',
    details: [],
    run: () => {
      const previous = useEnvironmentStore.getState().activeEnvironmentId;
      useEnvironmentStore.getState().setActiveEnvironment(target?.id ?? null);
      return {
        data: { activeEnvironmentId: target?.id ?? null },
        summary: target ? `Switched to “${target.name}”` : 'Cleared the active environment',
        undo: () => {
          if (useEnvironmentStore.getState().activeEnvironmentId !== (target?.id ?? null)) {
            throw new UndoConflictError('The active environment');
          }
          useEnvironmentStore.getState().setActiveEnvironment(previous);
        },
      };
    },
  };
};

const deleteEnvironmentVariable: ToolImpl<ControlToolInput<'delete_environment_variable'>> = (
  input,
  env
) => {
  const environment = editableEnvironment(input.environmentId, env);
  if ('refused' in environment) return environment;
  const variable = environment.variables.find((v) => v.key === input.key);
  if (!variable) return refuse(`No variable “${input.key}” in “${environment.name}”`);
  return {
    title: `Delete variable “${input.key}”`,
    details: [`From environment “${environment.name}”`],
    fingerprint: fingerprint(environment),
    run: () => {
      const snapshot = structuredClone(environment);
      useEnvironmentStore.getState().removeVariable(environment.id, variable.id);
      return {
        data: { deleted: input.key },
        summary: `Deleted “${input.key}” from “${environment.name}”`,
        undo: restoreEnvironment(snapshot),
      };
    },
  };
};

export const ENVIRONMENT_TOOLS = {
  create_environment: createEnvironment,
  set_environment_variable: setEnvironmentVariable,
  request_secret_variable: requestSecretVariable,
  set_active_environment: setActiveEnvironment,
  delete_environment_variable: deleteEnvironmentVariable,
} as const;
