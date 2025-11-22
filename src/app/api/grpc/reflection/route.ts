import { NextRequest, NextResponse } from 'next/server';

// Reflection service constants
const REFLECTION_SERVICE_V1 = 'grpc.reflection.v1.ServerReflection';
const REFLECTION_SERVICE_V1_ALPHA = 'grpc.reflection.v1alpha.ServerReflection';

// Maximum response size (10MB)
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;

interface ReflectionRequest {
  url: string;
  request: {
    listServices?: string;
    fileContainingSymbol?: string;
  };
  timeout?: number;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ReflectionRequest;
    const { url, request, timeout = 30000 } = body;

    if (!url) {
      return NextResponse.json(
        { error: 'URL is required' },
        { status: 400 }
      );
    }

    // Validate URL
    try {
      new URL(url);
    } catch {
      return NextResponse.json(
        { error: 'Invalid URL format' },
        { status: 400 }
      );
    }

    // Try v1 first, then fall back to v1alpha
    let response;
    let reflectionVersion = 'v1';

    try {
      response = await sendReflectionRequest(url, REFLECTION_SERVICE_V1, request, timeout);
    } catch {
      reflectionVersion = 'v1alpha';
      response = await sendReflectionRequest(url, REFLECTION_SERVICE_V1_ALPHA, request, timeout);
    }

    const responseData = typeof response === 'object' && response !== null
      ? { ...(response as Record<string, unknown>), reflectionVersion }
      : { data: response, reflectionVersion };

    return NextResponse.json(responseData, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Reflection request failed';
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

async function sendReflectionRequest(
  baseUrl: string,
  reflectionServiceName: string,
  request: ReflectionRequest['request'],
  timeout: number
): Promise<unknown> {
  const path = `/${reflectionServiceName}/ServerReflectionInfo`;
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Reflection request failed: ${response.statusText}`);
    }

    // Check response size
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
      throw new Error(`Response size exceeds maximum limit of ${MAX_RESPONSE_SIZE / 1024 / 1024}MB`);
    }

    const responseData = await response.json();
    return responseData;
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Reflection request timed out');
    }

    throw error;
  }
}
