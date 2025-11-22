import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import after mocking
import { POST } from '../route';
import { NextRequest } from 'next/server';

function createRequest(body: object): NextRequest {
  return new NextRequest('http://localhost:3000/api/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Proxy Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () => Promise.resolve('{"result": "success"}'),
    });
  });

  describe('Body Types', () => {
    it('should handle JSON body type', async () => {
      const request = createRequest({
        method: 'POST',
        url: 'https://api.example.com/data',
        bodyType: 'json',
        data: '{"key": "value"}',
      });

      const response = await POST(request);
      const json = await response.json();

      expect(json.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/data',
        expect.objectContaining({
          method: 'POST',
          body: '{"key": "value"}',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        })
      );
    });

    it('should handle text body type', async () => {
      const request = createRequest({
        method: 'POST',
        url: 'https://api.example.com/data',
        bodyType: 'text',
        data: 'plain text content',
      });

      const response = await POST(request);
      const json = await response.json();

      expect(json.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/data',
        expect.objectContaining({
          method: 'POST',
          body: 'plain text content',
          headers: expect.objectContaining({
            'Content-Type': 'text/plain',
          }),
        })
      );
    });

    it('should handle form-urlencoded body type with formData', async () => {
      const request = createRequest({
        method: 'POST',
        url: 'https://api.example.com/data',
        bodyType: 'form-urlencoded',
        formData: [
          { name: 'username', value: 'john' },
          { name: 'password', value: 'secret' },
        ],
      });

      const response = await POST(request);
      const json = await response.json();

      expect(json.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/data',
        expect.objectContaining({
          method: 'POST',
          body: 'username=john&password=secret',
          headers: expect.objectContaining({
            'Content-Type': 'application/x-www-form-urlencoded',
          }),
        })
      );
    });

    it('should handle form-urlencoded with legacy string data', async () => {
      const request = createRequest({
        method: 'POST',
        url: 'https://api.example.com/data',
        bodyType: 'form-urlencoded',
        data: 'key1=value1&key2=value2',
      });

      const response = await POST(request);
      const json = await response.json();

      expect(json.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/data',
        expect.objectContaining({
          method: 'POST',
          body: 'key1=value1&key2=value2',
        })
      );
    });

    it('should handle form-data body type', async () => {
      const request = createRequest({
        method: 'POST',
        url: 'https://api.example.com/upload',
        bodyType: 'form-data',
        formData: [
          { name: 'field1', value: 'text value' },
          { name: 'field2', value: 'another value' },
        ],
      });

      const response = await POST(request);
      const json = await response.json();

      expect(json.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/upload',
        expect.objectContaining({
          method: 'POST',
          body: expect.any(FormData),
        })
      );
    });

    it('should handle form-data with file upload', async () => {
      const fileContent = Buffer.from('test file content').toString('base64');
      const request = createRequest({
        method: 'POST',
        url: 'https://api.example.com/upload',
        bodyType: 'form-data',
        formData: [
          { name: 'description', value: 'My file' },
          {
            name: 'file',
            value: fileContent,
            filename: 'test.txt',
            contentType: 'text/plain',
          },
        ],
      });

      const response = await POST(request);
      const json = await response.json();

      expect(json.status).toBe(200);
      const callArgs = mockFetch.mock.calls[0];
      const formData = callArgs[1].body as FormData;
      expect(formData.get('description')).toBe('My file');
      expect(formData.get('file')).toBeInstanceOf(Blob);
    });

    it('should handle binary body type', async () => {
      const binaryData = Buffer.from([0x00, 0x01, 0x02, 0x03]).toString('base64');
      const request = createRequest({
        method: 'POST',
        url: 'https://api.example.com/binary',
        bodyType: 'binary',
        data: binaryData,
      });

      const response = await POST(request);
      const json = await response.json();

      expect(json.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/binary',
        expect.objectContaining({
          method: 'POST',
          body: expect.any(Buffer),
          headers: expect.objectContaining({
            'Content-Type': 'application/octet-stream',
          }),
        })
      );
    });

    it('should handle no body (none type)', async () => {
      const request = createRequest({
        method: 'GET',
        url: 'https://api.example.com/data',
        bodyType: 'none',
      });

      const response = await POST(request);
      const json = await response.json();

      expect(json.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/data',
        expect.objectContaining({
          method: 'GET',
        })
      );
      // Body should be undefined for GET
      expect(mockFetch.mock.calls[0][1].body).toBeUndefined();
    });

    it('should preserve user-specified Content-Type header', async () => {
      const request = createRequest({
        method: 'POST',
        url: 'https://api.example.com/data',
        bodyType: 'json',
        data: '{"key": "value"}',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });

      const response = await POST(request);
      const json = await response.json();

      expect(json.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/data',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json; charset=utf-8',
          }),
        })
      );
    });
  });

  describe('Backward Compatibility', () => {
    it('should work without bodyType (legacy mode)', async () => {
      const request = createRequest({
        method: 'POST',
        url: 'https://api.example.com/data',
        data: '{"key": "value"}',
      });

      const response = await POST(request);
      const json = await response.json();

      expect(json.status).toBe(200);
      // In legacy mode without bodyType, data is passed as-is
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/data',
        expect.objectContaining({
          method: 'POST',
        })
      );
    });
  });

  describe('Error Handling', () => {
    it('should reject invalid HTTP methods', async () => {
      const request = createRequest({
        method: 'INVALID',
        url: 'https://api.example.com/data',
      });

      const response = await POST(request);
      const json = await response.json();

      expect(response.status).toBe(400);
      expect(json.error).toContain('not allowed');
    });

    it('should handle timeout errors', async () => {
      mockFetch.mockImplementation(() => {
        const error = new Error('Aborted');
        error.name = 'AbortError';
        return Promise.reject(error);
      });

      const request = createRequest({
        method: 'GET',
        url: 'https://api.example.com/data',
        timeout: 1000,
      });

      const response = await POST(request);
      const json = await response.json();

      expect(response.status).toBe(504);
      expect(json.error).toContain('timeout');
    });
  });
});
