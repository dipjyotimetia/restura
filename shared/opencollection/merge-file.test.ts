import { describe, expect, it } from 'vitest';
import {
  detectOpenCollectionMergeFile,
  parseOpenCollectionMergeFile,
  serializeOpenCollectionMergeFile,
} from './merge-file';

const REQUEST = `info:
  type: http
  name: Users
http:
  method: GET
  url: https://example.com/users
x-team-metadata:
  owner: platform
`;

describe('OpenCollection merge files', () => {
  it('classifies root, folder, and schema-valid request files', () => {
    expect(detectOpenCollectionMergeFile('opencollection.yml', ['not yaml'])).toBe('root');
    expect(detectOpenCollectionMergeFile('users/_folder.yaml', ['not yaml'])).toBe('folder');
    expect(detectOpenCollectionMergeFile('users/get-users.yaml', [REQUEST])).toBe('request');
    expect(detectOpenCollectionMergeFile('fixtures/data.yaml', ['value: arbitrary'])).toBeNull();
  });

  it('validates without stripping unknown round-trip fields', () => {
    const parsed = parseOpenCollectionMergeFile('users/get-users.yaml', REQUEST, 'request');

    expect(parsed).toMatchObject({
      'x-team-metadata': { owner: 'platform' },
      http: { method: 'GET' },
    });
    expect(serializeOpenCollectionMergeFile(parsed)).toContain('x-team-metadata');
  });

  it('validates root and folder documents through their dedicated schemas', () => {
    expect(
      parseOpenCollectionMergeFile(
        'opencollection.yml',
        'opencollection: "1.0.0"\ninfo:\n  name: Root\nbundled: false\n',
        'root'
      )
    ).toMatchObject({ bundled: false });
    expect(
      parseOpenCollectionMergeFile(
        'users/_folder.yml',
        'info:\n  type: folder\n  name: Users\n',
        'folder'
      )
    ).toMatchObject({ info: { name: 'Users' } });
    expect(() =>
      parseOpenCollectionMergeFile('opencollection.yml', 'value: invalid\n', 'root')
    ).toThrow(/OpenCollection root/);
    expect(() =>
      parseOpenCollectionMergeFile('users/_folder.yml', 'value: invalid\n', 'folder')
    ).toThrow(/OpenCollection folder/);
  });

  it('rejects malformed or schema-invalid content with a useful file role', () => {
    expect(() =>
      parseOpenCollectionMergeFile('users/get-users.yaml', 'http: [', 'request')
    ).toThrow(/invalid yaml/i);
    expect(() =>
      parseOpenCollectionMergeFile('users/get-users.yaml', 'value: arbitrary', 'request')
    ).toThrow(/invalid OpenCollection request/i);
  });

  it('bounds nested documents before recursive validation', () => {
    let nested = 'value';
    for (let index = 0; index < 105; index += 1) nested = `level${index}:\n${indent(nested)}`;

    expect(() => parseOpenCollectionMergeFile('users/get-users.yaml', nested, 'request')).toThrow(
      /depth|maxDepth/i
    );
  });
});

function indent(value: string): string {
  return value
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}
