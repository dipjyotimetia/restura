import { describe, expect, it } from 'vitest';
import { importPostmanEnvironment, isPostmanEnvironment } from '../importers/postman-environment';

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
    const env = importPostmanEnvironment({
      name: 'Env',
      values: [
        { key: 'token', value: 'sek', type: 'secret' },
        { key: 'plain', value: 'pl', type: 'default' },
      ],
      _postman_variable_scope: 'environment',
    });
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
