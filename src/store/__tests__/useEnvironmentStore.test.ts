import { describe, it, expect, beforeEach } from 'vitest';
import { useEnvironmentStore } from '../useEnvironmentStore';

describe('useEnvironmentStore', () => {
  beforeEach(() => {
    useEnvironmentStore.setState({
      environments: [],
      activeEnvironmentId: null,
    });
    localStorage.clear();
  });

  describe('initial state', () => {
    it('should start with empty environments', () => {
      const state = useEnvironmentStore.getState();
      expect(state.environments).toEqual([]);
      expect(state.activeEnvironmentId).toBeNull();
    });
  });

  describe('createNewEnvironment', () => {
    it('should create environment with given name', () => {
      const { createNewEnvironment } = useEnvironmentStore.getState();
      const env = createNewEnvironment('Production');

      expect(env.name).toBe('Production');
      expect(env.id).toBeDefined();
      expect(env.variables).toEqual([]);
    });
  });

  describe('addEnvironment', () => {
    it('should add environment to list', () => {
      const { createNewEnvironment, addEnvironment } = useEnvironmentStore.getState();
      const env = createNewEnvironment('Production');
      addEnvironment(env);

      const state = useEnvironmentStore.getState();
      expect(state.environments).toHaveLength(1);
      expect(state.environments[0]).toEqual(env);
    });

    it('should support multiple environments', () => {
      const { createNewEnvironment, addEnvironment } = useEnvironmentStore.getState();
      const prod = createNewEnvironment('Production');
      const staging = createNewEnvironment('Staging');

      addEnvironment(prod);
      addEnvironment(staging);

      const state = useEnvironmentStore.getState();
      expect(state.environments).toHaveLength(2);
    });
  });

  describe('updateEnvironment', () => {
    it('should update environment name', () => {
      const { createNewEnvironment, addEnvironment, updateEnvironment } =
        useEnvironmentStore.getState();
      const env = createNewEnvironment('Old Name');
      addEnvironment(env);

      updateEnvironment(env.id, { name: 'New Name' });

      const state = useEnvironmentStore.getState();
      expect(state.environments[0]?.name).toBe('New Name');
    });
  });

  describe('deleteEnvironment', () => {
    it('should remove environment from list', () => {
      const { createNewEnvironment, addEnvironment, deleteEnvironment } =
        useEnvironmentStore.getState();
      const env = createNewEnvironment('To Delete');
      addEnvironment(env);

      deleteEnvironment(env.id);

      const state = useEnvironmentStore.getState();
      expect(state.environments).toHaveLength(0);
    });

    it('should clear activeEnvironmentId if deleted', () => {
      const { createNewEnvironment, addEnvironment, setActiveEnvironment, deleteEnvironment } =
        useEnvironmentStore.getState();
      const env = createNewEnvironment('Active');
      addEnvironment(env);
      setActiveEnvironment(env.id);

      deleteEnvironment(env.id);

      const state = useEnvironmentStore.getState();
      expect(state.activeEnvironmentId).toBeNull();
    });
  });

  describe('addVariable', () => {
    it('should add variable to environment', () => {
      const { createNewEnvironment, addEnvironment, addVariable } = useEnvironmentStore.getState();
      const env = createNewEnvironment('Test');
      addEnvironment(env);

      const variable = {
        id: 'var-1',
        key: 'API_URL',
        value: 'https://api.example.com',
        enabled: true,
      };
      addVariable(env.id, variable);

      const state = useEnvironmentStore.getState();
      expect(state.environments[0]?.variables).toHaveLength(1);
      expect(state.environments[0]?.variables[0]).toEqual(variable);
    });
  });

  describe('updateVariable', () => {
    it('should update variable in environment', () => {
      const { createNewEnvironment, addEnvironment, addVariable, updateVariable } =
        useEnvironmentStore.getState();
      const env = createNewEnvironment('Test');
      addEnvironment(env);

      const variable = {
        id: 'var-1',
        key: 'API_URL',
        value: 'https://old.com',
        enabled: true,
      };
      addVariable(env.id, variable);
      updateVariable(env.id, 'var-1', { value: 'https://new.com' });

      const state = useEnvironmentStore.getState();
      expect(state.environments[0]?.variables[0]?.value).toBe('https://new.com');
    });
  });

  describe('deleteVariable', () => {
    it('should remove variable from environment', () => {
      const { createNewEnvironment, addEnvironment, addVariable, deleteVariable } =
        useEnvironmentStore.getState();
      const env = createNewEnvironment('Test');
      addEnvironment(env);

      const variable = {
        id: 'var-1',
        key: 'API_URL',
        value: 'https://api.example.com',
        enabled: true,
      };
      addVariable(env.id, variable);
      deleteVariable(env.id, 'var-1');

      const state = useEnvironmentStore.getState();
      expect(state.environments[0]?.variables).toHaveLength(0);
    });
  });

  describe('resolveVariables', () => {
    it('should replace variables with their values', () => {
      const { createNewEnvironment, addEnvironment, addVariable, setActiveEnvironment, resolveVariables } =
        useEnvironmentStore.getState();
      const env = createNewEnvironment('Test');
      addEnvironment(env);

      addVariable(env.id, {
        id: 'var-1',
        key: 'baseUrl',
        value: 'https://api.example.com',
        enabled: true,
      });
      addVariable(env.id, {
        id: 'var-2',
        key: 'version',
        value: 'v1',
        enabled: true,
      });

      setActiveEnvironment(env.id);

      const resolved = resolveVariables('{{baseUrl}}/{{version}}/users');
      expect(resolved).toBe('https://api.example.com/v1/users');
    });

    it('should ignore disabled variables', () => {
      const { createNewEnvironment, addEnvironment, addVariable, setActiveEnvironment, resolveVariables } =
        useEnvironmentStore.getState();
      const env = createNewEnvironment('Test');
      addEnvironment(env);

      addVariable(env.id, {
        id: 'var-1',
        key: 'baseUrl',
        value: 'https://api.example.com',
        enabled: false,
      });

      setActiveEnvironment(env.id);

      const resolved = resolveVariables('{{baseUrl}}/users');
      expect(resolved).toBe('{{baseUrl}}/users');
    });

    it('should return original text if no active environment', () => {
      const { resolveVariables } = useEnvironmentStore.getState();
      const text = '{{baseUrl}}/users';
      expect(resolveVariables(text)).toBe(text);
    });

    it('should handle variables with spaces', () => {
      const { createNewEnvironment, addEnvironment, addVariable, setActiveEnvironment, resolveVariables } =
        useEnvironmentStore.getState();
      const env = createNewEnvironment('Test');
      addEnvironment(env);

      addVariable(env.id, {
        id: 'var-1',
        key: 'token',
        value: 'abc123',
        enabled: true,
      });

      setActiveEnvironment(env.id);

      const resolved = resolveVariables('{{ token }}');
      expect(resolved).toBe('abc123');
    });
  });

  describe('getActiveEnvironment', () => {
    it('should return null if no active environment', () => {
      const { getActiveEnvironment } = useEnvironmentStore.getState();
      expect(getActiveEnvironment()).toBeNull();
    });

    it('should return active environment', () => {
      const { createNewEnvironment, addEnvironment, setActiveEnvironment, getActiveEnvironment } =
        useEnvironmentStore.getState();
      const env = createNewEnvironment('Active');
      addEnvironment(env);
      setActiveEnvironment(env.id);

      const active = getActiveEnvironment();
      expect(active).toEqual(env);
    });

    it('should return null if active environment id does not exist', () => {
      const { setActiveEnvironment, getActiveEnvironment } = useEnvironmentStore.getState();
      setActiveEnvironment('non-existent');

      expect(getActiveEnvironment()).toBeNull();
    });
  });
});
