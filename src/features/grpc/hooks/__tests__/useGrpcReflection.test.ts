import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReflectionMethodInfo, ReflectionResult, ReflectionServiceInfo } from '@/types';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const discoverMock = vi.fn<() => Promise<ReflectionResult>>();

vi.mock('@/features/grpc/lib/grpcReflection', () => ({
  // Constructor must be a real function (not an arrow) so `new X()` works.
  GrpcReflectionClient: vi.fn(function MockReflectionClient() {
    return { discoverServices: discoverMock };
  }),
  generateRequestTemplate: vi.fn(() => '{}'),
}));

import { useGrpcReflection } from '../useGrpcReflection';
import { toast } from 'sonner';

const buildMethod = (overrides: Partial<ReflectionMethodInfo> = {}): ReflectionMethodInfo =>
  ({
    name: 'Greet',
    fullName: 'greet.v1.GreetService.Greet',
    inputType: '.greet.v1.GreetRequest',
    outputType: '.greet.v1.GreetResponse',
    clientStreaming: false,
    serverStreaming: false,
    ...overrides,
  }) as ReflectionMethodInfo;

const buildService = (overrides: Partial<ReflectionServiceInfo> = {}): ReflectionServiceInfo => ({
  name: 'GreetService',
  fullName: 'greet.v1.GreetService',
  methods: [buildMethod()],
  ...overrides,
});

const buildSuccessResult = (overrides: Partial<ReflectionResult> = {}): ReflectionResult => ({
  success: true,
  services: [buildService()],
  serverUrl: 'https://api.example.com',
  timestamp: 1700000000000,
  ...overrides,
});

const baseOptions = {
  url: 'https://api.example.com',
  resolveVariables: (text: string) => text,
  // Disable auto-discover by default — individual tests opt in to exercise it.
  autoDiscover: false,
};

describe('useGrpcReflection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts in an idle state', () => {
    const { result } = renderHook(() => useGrpcReflection(baseOptions));

    expect(result.current.result).toBeNull();
    expect(result.current.selectedService).toBeNull();
    expect(result.current.selectedMethod).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.showSchema).toBe(false);
  });

  it('does nothing when discover() is called without a URL', async () => {
    const { result } = renderHook(() => useGrpcReflection({ ...baseOptions, url: '' }));

    await act(async () => {
      await result.current.discover(false);
    });

    expect(discoverMock).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('URL required', expect.any(Object));
  });

  it('does nothing (and surfaces a toast) when the URL is invalid', async () => {
    const { result } = renderHook(() => useGrpcReflection({ ...baseOptions, url: 'not a url' }));

    await act(async () => {
      await result.current.discover(false);
    });

    expect(discoverMock).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Invalid URL', expect.any(Object));
  });

  it('populates result + auto-selects the first service/method on success', async () => {
    const onServiceSelected = vi.fn();
    const onMethodSelected = vi.fn();
    discoverMock.mockResolvedValueOnce(buildSuccessResult());

    const { result } = renderHook(() =>
      useGrpcReflection({ ...baseOptions, onServiceSelected, onMethodSelected })
    );

    await act(async () => {
      await result.current.discover(false);
    });

    expect(result.current.result?.success).toBe(true);
    expect(result.current.selectedService?.fullName).toBe('greet.v1.GreetService');
    expect(result.current.selectedMethod?.name).toBe('Greet');
    expect(onServiceSelected).toHaveBeenCalledTimes(1);
    expect(onMethodSelected).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('Services discovered', expect.any(Object));
  });

  it('surfaces a warning when discovery succeeds but yields no services', async () => {
    discoverMock.mockResolvedValueOnce(buildSuccessResult({ services: [] }));

    const { result } = renderHook(() => useGrpcReflection(baseOptions));

    await act(async () => {
      await result.current.discover(false);
    });

    expect(result.current.result?.success).toBe(true);
    expect(result.current.selectedService).toBeNull();
    expect(toast.warning).toHaveBeenCalledWith('No services found', expect.any(Object));
  });

  it('records an error result when discovery fails (success: false)', async () => {
    discoverMock.mockResolvedValueOnce({
      success: false,
      services: [],
      error: 'reflection unsupported',
      serverUrl: 'https://api.example.com',
      timestamp: 1,
    });

    const { result } = renderHook(() => useGrpcReflection(baseOptions));

    await act(async () => {
      await result.current.discover(false);
    });

    expect(result.current.result?.success).toBe(false);
    expect(result.current.result?.error).toBe('reflection unsupported');
    expect(toast.error).toHaveBeenCalledWith('Discovery failed', expect.any(Object));
  });

  it('records an error result when discoverServices() throws', async () => {
    discoverMock.mockRejectedValueOnce(new Error('boom'));

    const { result } = renderHook(() => useGrpcReflection(baseOptions));

    await act(async () => {
      await result.current.discover(false);
    });

    expect(result.current.result?.success).toBe(false);
    expect(result.current.result?.error).toBe('boom');
    expect(toast.error).toHaveBeenCalledWith('Discovery failed', expect.any(Object));
  });

  it('selectService clears the previously selected method', async () => {
    discoverMock.mockResolvedValueOnce(buildSuccessResult());

    const { result } = renderHook(() => useGrpcReflection(baseOptions));

    await act(async () => {
      await result.current.discover(false);
    });
    expect(result.current.selectedMethod?.name).toBe('Greet');

    const otherService = buildService({
      fullName: 'other.v1.OtherService',
      name: 'OtherService',
      methods: [buildMethod({ name: 'Other' })],
    });

    act(() => {
      result.current.selectService(otherService);
    });

    expect(result.current.selectedService?.fullName).toBe('other.v1.OtherService');
    expect(result.current.selectedMethod).toBeNull();
  });

  it('refresh (calling discover again) replaces the previous result', async () => {
    discoverMock.mockResolvedValueOnce(buildSuccessResult());
    const { result } = renderHook(() => useGrpcReflection(baseOptions));

    await act(async () => {
      await result.current.discover(false);
    });
    expect(result.current.result?.services).toHaveLength(1);

    discoverMock.mockResolvedValueOnce(
      buildSuccessResult({
        services: [
          buildService({ fullName: 'a.A', methods: [buildMethod({ name: 'A1' })] }),
          buildService({ fullName: 'b.B', methods: [buildMethod({ name: 'B1' })] }),
        ],
      })
    );

    await act(async () => {
      await result.current.discover(false);
    });

    expect(result.current.result?.services).toHaveLength(2);
    expect(result.current.selectedService?.fullName).toBe('a.A');
  });

  it('auto-discovers (silently) after the debounce when autoDiscover is on', async () => {
    vi.useFakeTimers();
    discoverMock.mockResolvedValueOnce(buildSuccessResult());
    const { result } = renderHook(() => useGrpcReflection({ ...baseOptions, autoDiscover: true }));

    expect(discoverMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });

    expect(discoverMock).toHaveBeenCalledTimes(1);
    // Silent path should not surface the success toast.
    expect(toast.success).not.toHaveBeenCalled();
    expect(result.current.result?.success).toBe(true);
  });

  it('toggles showSchema via setShowSchema', () => {
    const { result } = renderHook(() => useGrpcReflection(baseOptions));
    expect(result.current.showSchema).toBe(false);
    act(() => {
      result.current.setShowSchema(true);
    });
    expect(result.current.showSchema).toBe(true);
  });
});
