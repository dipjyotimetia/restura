import { describe, expect, it } from 'vitest';
import {
  importPostmanEnvironment,
  importPostmanEnvironmentDetailed,
  isPostmanEnvironment,
} from '../importers/postman-environment';

describe('isPostmanEnvironment', () => {
  it('returns true for a valid environment file', () => {
    const env = {
      id: 'abc-123',
      name: 'Staging',
      values: [{ key: 'host', value: 'https://staging.example.com', enabled: true }],
      _postman_variable_scope: 'environment',
    };
    expect(isPostmanEnvironment(env)).toBe(true);
  });

  it('returns false for a Postman collection (different scope discriminator)', () => {
    const collection = {
      info: {
        name: 'My Collection',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [],
    };
    expect(isPostmanEnvironment(collection)).toBe(false);
  });

  it('returns false for null/undefined/non-object inputs', () => {
    expect(isPostmanEnvironment(null)).toBe(false);
    expect(isPostmanEnvironment(undefined)).toBe(false);
    expect(isPostmanEnvironment('string')).toBe(false);
    expect(isPostmanEnvironment(42)).toBe(false);
  });

  it('returns false when scope is "globals" instead of "environment"', () => {
    const globals = {
      name: 'Globals',
      values: [],
      _postman_variable_scope: 'globals',
    };
    expect(isPostmanEnvironment(globals)).toBe(false);
  });

  it('returns false when values is missing', () => {
    expect(isPostmanEnvironment({ name: 'Foo', _postman_variable_scope: 'environment' })).toBe(
      false
    );
  });
});

describe('importPostmanEnvironment', () => {
  it('maps name and variable list correctly', () => {
    const env = importPostmanEnvironment({
      name: 'Production',
      values: [
        { key: 'apiBase', value: 'https://api.prod.example.com', enabled: true },
        { key: 'apiKey', value: 'secret-123', enabled: true, type: 'secret' },
      ],
      _postman_variable_scope: 'environment',
    });

    expect(env.name).toBe('Production');
    expect(env.variables).toHaveLength(2);
    expect(env.variables[0]!.key).toBe('apiBase');
    expect(env.variables[0]!.value).toBe('https://api.prod.example.com');
    expect(env.variables[0]!.enabled).toBe(true);
  });

  it('flags secret-typed variables with secret: true', () => {
    const env = importPostmanEnvironment(
      {
        name: 'Env',
        values: [
          { key: 'token', value: 'sek', type: 'secret' },
          { key: 'plain', value: 'pl', type: 'default' },
        ],
        _postman_variable_scope: 'environment',
      },
      { keepSecretValues: true }
    );
    expect(env.variables[0]!.secret).toBe(true);
    expect(env.variables[1]!.secret).toBeUndefined();
  });

  it('treats missing enabled as enabled=true (Postman default)', () => {
    const env = importPostmanEnvironment({
      name: 'Env',
      values: [{ key: 'x', value: 'y' }],
      _postman_variable_scope: 'environment',
    });
    expect(env.variables[0]!.enabled).toBe(true);
  });

  it('treats enabled=false as disabled', () => {
    const env = importPostmanEnvironment({
      name: 'Env',
      values: [{ key: 'x', value: 'y', enabled: false }],
      _postman_variable_scope: 'environment',
    });
    expect(env.variables[0]!.enabled).toBe(false);
  });

  it('coerces missing value to empty string', () => {
    const env = importPostmanEnvironment({
      name: 'Env',
      // biome-ignore lint/suspicious/noExplicitAny: intentionally testing missing value
      values: [{ key: 'x' } as any],
      _postman_variable_scope: 'environment',
    });
    expect(env.variables[0]!.value).toBe('');
  });

  it('throws when input is not a Postman environment file', () => {
    expect(() => importPostmanEnvironment({ info: { name: 'X' }, item: [] })).toThrow(
      /Postman environment file/
    );
  });

  it('generates unique ids for environment and each variable', () => {
    const env = importPostmanEnvironment({
      name: 'Env',
      values: [
        { key: 'a', value: '1' },
        { key: 'b', value: '2' },
      ],
      _postman_variable_scope: 'environment',
    });
    expect(env.id).toBeTruthy();
    expect(env.variables[0]!.id).toBeTruthy();
    expect(env.variables[1]!.id).toBeTruthy();
    expect(env.variables[0]!.id).not.toBe(env.variables[1]!.id);
    expect(env.id).not.toBe(env.variables[0]!.id);
  });
});

describe('importPostmanEnvironment secret values (#1231)', () => {
  const file = {
    name: 'Prod',
    values: [
      { key: 'apiBase', value: 'https://api.example.com', type: 'default' },
      { key: 'apiKey', value: 'sk-live-123', type: 'secret' },
      { key: 'password', value: 'hunter2', type: 'secret', enabled: false },
    ],
    _postman_variable_scope: 'environment',
  };

  it('drops secret values by default and warns with the keys only', () => {
    const result = importPostmanEnvironmentDetailed(file);
    expect(
      result.environment.variables.map(({ key, value, secret, enabled }) => ({
        key,
        value,
        secret,
        enabled,
      }))
    ).toMatchInlineSnapshot(`
      [
        {
          "enabled": true,
          "key": "apiBase",
          "secret": undefined,
          "value": "https://api.example.com",
        },
        {
          "enabled": true,
          "key": "apiKey",
          "secret": true,
          "value": "",
        },
        {
          "enabled": false,
          "key": "password",
          "secret": true,
          "value": "",
        },
      ]
    `);
    expect(result.droppedSecretKeys).toEqual(['apiKey', 'password']);
    expect(result.warnings).toMatchInlineSnapshot(`
      [
        {
          "construct": "secret-variable",
          "detail": "Secret variable imported without a value; re-enter it: apiKey",
          "kind": "unmodelled-construct",
          "requestName": "Prod",
        },
        {
          "construct": "secret-variable",
          "detail": "Secret variable imported without a value; re-enter it: password",
          "kind": "unmodelled-construct",
          "requestName": "Prod",
        },
      ]
    `);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('sk-live-123');
    expect(serialized).not.toContain('hunter2');
  });

  it('the plain importer also drops secret values when no option is given', () => {
    const env = importPostmanEnvironment(file);
    expect(env.variables.find((v) => v.key === 'apiKey')).toMatchObject({
      value: '',
      secret: true,
    });
  });

  it('keeps secret values with keepSecretValues: true and does not warn', () => {
    const result = importPostmanEnvironmentDetailed(file, { keepSecretValues: true });
    expect(result.environment.variables.map((v) => [v.key, v.value, v.secret])).toEqual([
      ['apiBase', 'https://api.example.com', undefined],
      ['apiKey', 'sk-live-123', true],
      ['password', 'hunter2', true],
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.droppedSecretKeys).toEqual([]);
  });

  it('leaves non-secret variables untouched when dropping', () => {
    const result = importPostmanEnvironmentDetailed(file, { keepSecretValues: false });
    expect(result.environment.variables[0]).toMatchObject({
      key: 'apiBase',
      value: 'https://api.example.com',
      enabled: true,
    });
    expect(result.environment.variables[0]!.secret).toBeUndefined();
  });
});
