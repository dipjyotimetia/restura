// @vitest-environment node
import { vi } from 'vitest';
import { z } from 'zod';
import {
  HttpRequestConfigSchema,
  GrpcRequestConfigSchema,
  GrpcSendMessageSchema,
  GrpcStreamRequestIdSchema,
  FilePathSchema,
  ShellUrlSchema,
  validateIpcInput,
  createValidatedHandler,
  MAX_HTTP_BODY_BYTES,
  MAX_PROTO_CONTENT_BYTES,
} from '../ipc-validators';

// Reusable trusted event for tests that need a valid sender frame (file://
// is what the packaged Electron renderer uses).
const trustedEvent = {
  sender: { id: 1 },
  senderFrame: { url: 'file:///' },
} as unknown as Electron.IpcMainInvokeEvent;

describe('validateIpcInput', () => {
  describe('HttpRequestConfigSchema', () => {
    it('valid HTTP config passes', () => {
      const input = { method: 'GET', url: 'https://example.com' };
      expect(() => validateIpcInput(HttpRequestConfigSchema, input, 'http:request')).not.toThrow();
    });

    it('invalid URL in HTTP config throws with message containing the channel name', () => {
      const input = { method: 'GET', url: 'not-a-url' };
      expect(() => validateIpcInput(HttpRequestConfigSchema, input, 'http:request')).toThrow('http:request');
    });

    it('HTTP body over 50MB throws', () => {
      const input = {
        method: 'POST',
        url: 'https://example.com',
        data: 'x'.repeat(MAX_HTTP_BODY_BYTES + 1),
      };
      expect(() => validateIpcInput(HttpRequestConfigSchema, input, 'http:request')).toThrow();
    });
  });

  describe('GrpcRequestConfigSchema', () => {
    const validGrpc = {
      url: 'https://grpc.example.com',
      service: 'MyService',
      method: 'MyMethod',
      methodType: 'unary' as const,
      metadata: {},
      message: {},
      protoContent: 'syntax = "proto3";',
      protoFileName: 'my.proto',
    };

    it('valid gRPC config passes', () => {
      expect(() => validateIpcInput(GrpcRequestConfigSchema, validGrpc, 'grpc:invoke')).not.toThrow();
    });

    it('gRPC with empty service name throws', () => {
      const input = { ...validGrpc, service: '' };
      expect(() => validateIpcInput(GrpcRequestConfigSchema, input, 'grpc:invoke')).toThrow();
    });

    it('proto content over 1MB throws', () => {
      const input = { ...validGrpc, protoContent: 'x'.repeat(MAX_PROTO_CONTENT_BYTES + 1) };
      expect(() => validateIpcInput(GrpcRequestConfigSchema, input, 'grpc:invoke')).toThrow();
    });
  });

  describe('FilePathSchema', () => {
    it('file path empty string throws', () => {
      expect(() => validateIpcInput(FilePathSchema, '', 'fs:readFile')).toThrow();
    });

    it('file path over 4096 chars throws', () => {
      const longPath = '/tmp/' + 'a'.repeat(4093);
      expect(() => validateIpcInput(FilePathSchema, longPath, 'fs:readFile')).toThrow();
    });
  });

  describe('ShellUrlSchema', () => {
    it('shell URL with file:// protocol throws', () => {
      expect(() => validateIpcInput(ShellUrlSchema, 'file:///etc/passwd', 'shell:openExternal')).toThrow();
    });

    it('shell URL with http:// passes', () => {
      expect(() => validateIpcInput(ShellUrlSchema, 'http://example.com', 'shell:openExternal')).not.toThrow();
    });
  });
});

describe('GrpcRequestConfigSchema — streaming method types', () => {
  const validGrpc = {
    url: 'https://grpc.example.com',
    service: 'MyService',
    method: 'MyMethod',
    methodType: 'unary' as const,
    metadata: {},
    message: {},
    protoContent: 'syntax = "proto3";',
    protoFileName: 'my.proto',
  };

  it('accepts methodType client-streaming', () => {
    expect(() =>
      validateIpcInput(
        GrpcRequestConfigSchema,
        { ...validGrpc, methodType: 'client-streaming' },
        'grpc:start-stream'
      )
    ).not.toThrow();
  });

  it('accepts methodType bidirectional-streaming', () => {
    expect(() =>
      validateIpcInput(
        GrpcRequestConfigSchema,
        { ...validGrpc, methodType: 'bidirectional-streaming' },
        'grpc:start-stream'
      )
    ).not.toThrow();
  });
});

describe('GrpcSendMessageSchema', () => {
  it('accepts a plain object message', () => {
    expect(() =>
      validateIpcInput(GrpcSendMessageSchema, ['req-id-1', { field: 'value' }], 'grpc:send-message')
    ).not.toThrow();
  });

  it('accepts an array message', () => {
    expect(() =>
      validateIpcInput(GrpcSendMessageSchema, ['req-id-1', [1, 2, 3]], 'grpc:send-message')
    ).not.toThrow();
  });

  it('rejects empty request ID', () => {
    expect(() =>
      validateIpcInput(GrpcSendMessageSchema, ['', { field: 'value' }], 'grpc:send-message')
    ).toThrow();
  });
});

describe('GrpcStreamRequestIdSchema', () => {
  it('accepts a valid request ID', () => {
    expect(() =>
      validateIpcInput(GrpcStreamRequestIdSchema, 'req-abc-123', 'grpc:end-stream')
    ).not.toThrow();
  });

  it('rejects an empty string request ID', () => {
    expect(() =>
      validateIpcInput(GrpcStreamRequestIdSchema, '', 'grpc:end-stream')
    ).toThrow();
  });
});

describe('createValidatedHandler', () => {
  it('calls handler with validated input when valid', async () => {
    const handler = vi.fn().mockResolvedValue('result');
    const wrapped = createValidatedHandler('test:channel', ShellUrlSchema, handler);
    await wrapped(trustedEvent, 'https://example.com');
    expect(handler).toHaveBeenCalledWith('https://example.com');
  });

  it('throws and does not call handler when invalid', async () => {
    const handler = vi.fn();
    const wrapped = createValidatedHandler('test:channel', ShellUrlSchema, handler);
    await expect(
      wrapped(trustedEvent, 'file:///etc/passwd')
    ).rejects.toThrow('test:channel');
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes through the handler return value', async () => {
    const handler = vi.fn().mockResolvedValue(42);
    const wrapped = createValidatedHandler('test:channel', ShellUrlSchema, handler);
    const result = await wrapped(trustedEvent, 'https://example.com');
    expect(result).toBe(42);
  });
});

describe('createValidatedHandler frame validation', () => {
  it('rejects events from non-main frames', async () => {
    const handler = createValidatedHandler('test:channel', z.string(), async (s) => s);
    const evt = {
      sender: { id: 1 },
      senderFrame: { url: 'https://attacker.example/' },
    } as unknown as Electron.IpcMainInvokeEvent;
    await expect(handler(evt, 'hello')).rejects.toThrow(/untrusted frame/i);
  });

  it('accepts events from the main file:// frame (Electron prod build)', async () => {
    const handler = createValidatedHandler('test:channel', z.string(), async (s) => s);
    const evt = {
      sender: { id: 1 },
      senderFrame: { url: 'file:///path/to/dist/web/index.html' },
    } as unknown as Electron.IpcMainInvokeEvent;
    await expect(handler(evt, 'hello')).resolves.toBe('hello');
  });

  it('accepts events from localhost:5173 dev server', async () => {
    const handler = createValidatedHandler('test:channel', z.string(), async (s) => s);
    const evt = {
      sender: { id: 1 },
      senderFrame: { url: 'http://localhost:5173/' },
    } as unknown as Electron.IpcMainInvokeEvent;
    await expect(handler(evt, 'hello')).resolves.toBe('hello');
  });

  it('accepts events from 127.0.0.1:5173 dev server', async () => {
    const handler = createValidatedHandler('test:channel', z.string(), async (s) => s);
    const evt = {
      sender: { id: 1 },
      senderFrame: { url: 'http://127.0.0.1:5173/' },
    } as unknown as Electron.IpcMainInvokeEvent;
    await expect(handler(evt, 'hello')).resolves.toBe('hello');
  });

  it('rejects when senderFrame is undefined', async () => {
    const handler = createValidatedHandler('test:channel', z.string(), async (s) => s);
    const evt = {
      sender: { id: 1 },
      senderFrame: undefined,
    } as unknown as Electron.IpcMainInvokeEvent;
    await expect(handler(evt, 'hello')).rejects.toThrow(/untrusted frame/i);
  });

  it('rejects http://localhost on a non-5173 port', async () => {
    const handler = createValidatedHandler('test:channel', z.string(), async (s) => s);
    const evt = {
      sender: { id: 1 },
      senderFrame: { url: 'http://localhost:8080/' },
    } as unknown as Electron.IpcMainInvokeEvent;
    await expect(handler(evt, 'hello')).rejects.toThrow(/untrusted frame/i);
  });
});
