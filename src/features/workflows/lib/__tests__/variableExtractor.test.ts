import { describe, it, expect } from 'vitest';
import {
  parseJsonSafely,
  extractByJsonPath,
  extractByRegex,
  extractByHeader,
  extractVariables,
  testExtraction,
} from '../variableExtractor';
import { VariableExtraction, Response } from '@/types';

describe('variableExtractor', () => {
  describe('parseJsonSafely', () => {
    it('should parse valid JSON', () => {
      expect(parseJsonSafely('{"key": "value"}')).toEqual({ key: 'value' });
    });

    it('should return null for invalid JSON', () => {
      expect(parseJsonSafely('not json')).toBeNull();
    });

    it('should handle arrays', () => {
      expect(parseJsonSafely('[1, 2, 3]')).toEqual([1, 2, 3]);
    });
  });

  describe('extractByJsonPath', () => {
    const body = JSON.stringify({
      data: {
        user: {
          id: '123',
          name: 'John',
          emails: ['john@example.com', 'j@test.com'],
        },
        token: 'abc123',
      },
      status: 'success',
    });

    it('should extract simple property', () => {
      expect(extractByJsonPath(body, 'status')).toBe('success');
    });

    it('should extract nested property', () => {
      expect(extractByJsonPath(body, 'data.user.id')).toBe('123');
    });

    it('should extract deeply nested property', () => {
      expect(extractByJsonPath(body, 'data.user.name')).toBe('John');
    });

    it('should extract array element', () => {
      expect(extractByJsonPath(body, 'data.user.emails[0]')).toBe('john@example.com');
    });

    it('should extract second array element', () => {
      expect(extractByJsonPath(body, 'data.user.emails[1]')).toBe('j@test.com');
    });

    it('should return undefined for non-existent path', () => {
      expect(extractByJsonPath(body, 'data.nonexistent')).toBeUndefined();
    });

    it('should return undefined for invalid path', () => {
      expect(extractByJsonPath(body, 'data.user.emails[10]')).toBeUndefined();
    });

    it('should stringify objects', () => {
      const result = extractByJsonPath(body, 'data.user');
      expect(result).toBe(JSON.stringify({ id: '123', name: 'John', emails: ['john@example.com', 'j@test.com'] }));
    });

    it('should handle invalid JSON', () => {
      expect(extractByJsonPath('not json', 'path')).toBeUndefined();
    });

    it('should handle numeric values', () => {
      const numBody = JSON.stringify({ count: 42 });
      expect(extractByJsonPath(numBody, 'count')).toBe('42');
    });

    it('should handle boolean values', () => {
      const boolBody = JSON.stringify({ active: true });
      expect(extractByJsonPath(boolBody, 'active')).toBe('true');
    });
  });

  describe('extractByRegex', () => {
    const body = 'The token is "abc123" and the id is 456';

    it('should extract with capture group', () => {
      expect(extractByRegex(body, '"([^"]+)"')).toBe('abc123');
    });

    it('should return full match without capture group', () => {
      // Body is 'The token is "abc123" and the id is 456'
      // First \d+ match is "123" in "abc123"
      expect(extractByRegex(body, '\\d+')).toBe('123');
    });

    it('should extract the id specifically', () => {
      expect(extractByRegex(body, 'id is (\\d+)')).toBe('456');
    });

    it('should return undefined for no match', () => {
      expect(extractByRegex(body, 'xyz')).toBeUndefined();
    });

    it('should handle invalid regex', () => {
      expect(extractByRegex(body, '[')).toBeUndefined();
    });

    it('should extract JSON values', () => {
      const jsonBody = '{"token":"secret123","user":"john"}';
      expect(extractByRegex(jsonBody, '"token":"([^"]+)"')).toBe('secret123');
    });
  });

  describe('extractByHeader', () => {
    const headers = {
      'Content-Type': 'application/json',
      'X-Request-Id': 'req-123',
      'Set-Cookie': ['cookie1=value1', 'cookie2=value2'],
    };

    it('should extract header value', () => {
      expect(extractByHeader(headers, 'Content-Type')).toBe('application/json');
    });

    it('should be case-insensitive', () => {
      expect(extractByHeader(headers, 'content-type')).toBe('application/json');
      expect(extractByHeader(headers, 'CONTENT-TYPE')).toBe('application/json');
    });

    it('should extract custom header', () => {
      expect(extractByHeader(headers, 'X-Request-Id')).toBe('req-123');
    });

    it('should join array values', () => {
      expect(extractByHeader(headers, 'Set-Cookie')).toBe('cookie1=value1, cookie2=value2');
    });

    it('should return undefined for non-existent header', () => {
      expect(extractByHeader(headers, 'X-Missing')).toBeUndefined();
    });
  });

  describe('extractVariables', () => {
    const response: Response = {
      id: 'resp-1',
      requestId: 'req-1',
      status: 200,
      statusText: 'OK',
      headers: {
        'Content-Type': 'application/json',
        'X-Token': 'header-token',
      },
      body: JSON.stringify({
        data: {
          userId: 'user-123',
          token: 'body-token',
        },
      }),
      size: 100,
      time: 50,
      timestamp: Date.now(),
    };

    it('should extract multiple variables', () => {
      const extractions: VariableExtraction[] = [
        {
          id: '1',
          variableName: 'userId',
          extractionMethod: 'jsonpath',
          path: 'data.userId',
        },
        {
          id: '2',
          variableName: 'token',
          extractionMethod: 'jsonpath',
          path: 'data.token',
        },
      ];

      const result = extractVariables(response, extractions);
      expect(result).toEqual({
        userId: 'user-123',
        token: 'body-token',
      });
    });

    it('should extract from headers', () => {
      const extractions: VariableExtraction[] = [
        {
          id: '1',
          variableName: 'headerToken',
          extractionMethod: 'header',
          path: 'X-Token',
        },
      ];

      const result = extractVariables(response, extractions);
      expect(result).toEqual({ headerToken: 'header-token' });
    });

    it('should extract using regex', () => {
      const extractions: VariableExtraction[] = [
        {
          id: '1',
          variableName: 'extractedToken',
          extractionMethod: 'regex',
          path: '"token":"([^"]+)"',
        },
      ];

      const result = extractVariables(response, extractions);
      expect(result).toEqual({ extractedToken: 'body-token' });
    });

    it('should skip failed extractions', () => {
      const extractions: VariableExtraction[] = [
        {
          id: '1',
          variableName: 'valid',
          extractionMethod: 'jsonpath',
          path: 'data.userId',
        },
        {
          id: '2',
          variableName: 'invalid',
          extractionMethod: 'jsonpath',
          path: 'nonexistent.path',
        },
      ];

      const result = extractVariables(response, extractions);
      expect(result).toEqual({ valid: 'user-123' });
    });

    it('should handle empty extractions', () => {
      const result = extractVariables(response, []);
      expect(result).toEqual({});
    });
  });

  describe('testExtraction', () => {
    const body = JSON.stringify({ data: { value: 'test' } });
    const headers = { 'Content-Type': 'application/json' };

    it('should return success for valid extraction', () => {
      const extraction: VariableExtraction = {
        id: '1',
        variableName: 'testVar',
        extractionMethod: 'jsonpath',
        path: 'data.value',
      };

      const result = testExtraction(body, headers, extraction);
      expect(result).toEqual({ success: true, value: 'test' });
    });

    it('should return error for failed extraction', () => {
      const extraction: VariableExtraction = {
        id: '1',
        variableName: 'testVar',
        extractionMethod: 'jsonpath',
        path: 'nonexistent',
      };

      const result = testExtraction(body, headers, extraction);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should work with header extraction', () => {
      const extraction: VariableExtraction = {
        id: '1',
        variableName: 'contentType',
        extractionMethod: 'header',
        path: 'Content-Type',
      };

      const result = testExtraction(body, headers, extraction);
      expect(result).toEqual({ success: true, value: 'application/json' });
    });
  });
});
