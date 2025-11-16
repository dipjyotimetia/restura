import { describe, it, expect, beforeEach } from 'vitest';
import { useRequestStore } from '../useRequestStore';
import { HttpRequest, GrpcRequest } from '@/types';

describe('useRequestStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useRequestStore.setState({
      currentRequest: null,
      currentResponse: null,
      scriptResult: null,
      isLoading: false,
    });
    localStorage.clear();
  });

  describe('initial state', () => {
    it('should start with null current request when reset', () => {
      const state = useRequestStore.getState();
      expect(state.currentRequest).toBeNull();
      expect(state.currentResponse).toBeNull();
      expect(state.isLoading).toBe(false);
    });
  });

  describe('createNewHttpRequest', () => {
    it('should create a new HTTP request with default values', () => {
      const { createNewHttpRequest } = useRequestStore.getState();
      createNewHttpRequest();

      const state = useRequestStore.getState();
      const request = state.currentRequest as HttpRequest;

      expect(request).toBeDefined();
      expect(request.type).toBe('http');
      expect(request.method).toBe('GET');
      expect(request.url).toBe('');
      expect(request.headers).toEqual([]);
      expect(request.params).toEqual([]);
      expect(request.body.type).toBe('none');
      expect(request.auth.type).toBe('none');
      expect(request.id).toBeDefined();
      expect(request.name).toBe('New Request');
    });

    it('should clear current response when creating new request', () => {
      const { setCurrentResponse, createNewHttpRequest } = useRequestStore.getState();
      setCurrentResponse({
        id: 'test',
        requestId: 'test',
        status: 200,
        statusText: 'OK',
        headers: {},
        body: '{}',
        size: 2,
        time: 100,
        timestamp: Date.now(),
      });

      createNewHttpRequest();
      const state = useRequestStore.getState();
      expect(state.currentResponse).toBeNull();
    });
  });

  describe('createNewGrpcRequest', () => {
    it('should create a new gRPC request with default values', () => {
      const { createNewGrpcRequest } = useRequestStore.getState();
      createNewGrpcRequest();

      const state = useRequestStore.getState();
      const request = state.currentRequest as GrpcRequest;

      expect(request).toBeDefined();
      expect(request.type).toBe('grpc');
      expect(request.methodType).toBe('unary');
      expect(request.url).toBe('');
      expect(request.service).toBe('');
      expect(request.method).toBe('');
      expect(request.metadata).toEqual([]);
      expect(request.message).toBe('');
      expect(request.auth.type).toBe('none');
    });
  });

  describe('updateRequest', () => {
    it('should update HTTP request fields', () => {
      const { createNewHttpRequest, updateRequest } = useRequestStore.getState();
      createNewHttpRequest();

      updateRequest({
        url: 'https://api.example.com',
        method: 'POST',
      });

      const state = useRequestStore.getState();
      const request = state.currentRequest as HttpRequest;
      expect(request.url).toBe('https://api.example.com');
      expect(request.method).toBe('POST');
    });

    it('should update headers array', () => {
      const { createNewHttpRequest, updateRequest } = useRequestStore.getState();
      createNewHttpRequest();

      const newHeaders = [
        { id: '1', key: 'Content-Type', value: 'application/json', enabled: true },
        { id: '2', key: 'Authorization', value: 'Bearer token', enabled: true },
      ];

      updateRequest({ headers: newHeaders });

      const state = useRequestStore.getState();
      const request = state.currentRequest as HttpRequest;
      expect(request.headers).toEqual(newHeaders);
    });

    it('should not update if no current request exists', () => {
      const { updateRequest } = useRequestStore.getState();
      updateRequest({ url: 'https://api.example.com' });

      const state = useRequestStore.getState();
      expect(state.currentRequest).toBeNull();
    });
  });

  describe('setLoading', () => {
    it('should set loading state', () => {
      const { setLoading } = useRequestStore.getState();

      setLoading(true);
      expect(useRequestStore.getState().isLoading).toBe(true);

      setLoading(false);
      expect(useRequestStore.getState().isLoading).toBe(false);
    });
  });

  describe('setCurrentResponse', () => {
    it('should set the current response', () => {
      const { setCurrentResponse } = useRequestStore.getState();
      const response = {
        id: 'resp-1',
        requestId: 'req-1',
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        body: '{"message": "success"}',
        size: 24,
        time: 150,
        timestamp: Date.now(),
      };

      setCurrentResponse(response);
      const state = useRequestStore.getState();
      expect(state.currentResponse).toEqual(response);
    });

    it('should clear response when set to null', () => {
      const { setCurrentResponse } = useRequestStore.getState();
      setCurrentResponse({
        id: 'test',
        requestId: 'test',
        status: 200,
        statusText: 'OK',
        headers: {},
        body: '{}',
        size: 2,
        time: 100,
        timestamp: Date.now(),
      });

      setCurrentResponse(null);
      expect(useRequestStore.getState().currentResponse).toBeNull();
    });
  });

  describe('setScriptResult', () => {
    it('should set script results', () => {
      const { setScriptResult } = useRequestStore.getState();
      const results = {
        preRequest: {
          success: true,
          logs: [{ type: 'log' as const, message: 'test', timestamp: Date.now() }],
          errors: [],
          variables: { key: 'value' },
        },
        test: {
          success: true,
          logs: [],
          errors: [],
          variables: {},
          tests: [{ name: 'Test 1', passed: true }],
        },
      };

      setScriptResult(results);
      expect(useRequestStore.getState().scriptResult).toEqual(results);
    });
  });

  describe('clearRequest', () => {
    it('should clear all request-related state', () => {
      const { createNewHttpRequest, setCurrentResponse, setScriptResult, clearRequest } =
        useRequestStore.getState();

      createNewHttpRequest();
      setCurrentResponse({
        id: 'test',
        requestId: 'test',
        status: 200,
        statusText: 'OK',
        headers: {},
        body: '{}',
        size: 2,
        time: 100,
        timestamp: Date.now(),
      });
      setScriptResult({
        preRequest: {
          success: true,
          logs: [],
          errors: [],
          variables: {},
        },
      });

      clearRequest();

      const state = useRequestStore.getState();
      expect(state.currentRequest).toBeNull();
      expect(state.currentResponse).toBeNull();
      expect(state.scriptResult).toBeNull();
    });
  });
});
