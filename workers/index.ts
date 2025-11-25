export default {
  async fetch(request: Request): Promise<Response> {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (url.pathname === '/api/proxy' || url.pathname.startsWith('/api/proxy/')) {
      return handleHttpProxy(request, corsHeaders);
    } else if (url.pathname === '/api/grpc/reflection') {
      return handleGrpcReflection(request, corsHeaders);
    } else if (url.pathname === '/api/grpc' || url.pathname.startsWith('/api/grpc/')) {
      return handleGrpcProxy(request, corsHeaders);
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  },
};

// HTTP Proxy Handler
async function handleHttpProxy(request: Request, corsHeaders: Record<string, string>): Promise<Response> {
  try {
    const body = await request.json();
    const { url, method, headers, data, bodyType, timeout } = body;

    // Validate URL (SSRF protection)
    if (!validateURL(url)) {
      return new Response(
        JSON.stringify({ error: 'Invalid or unsafe URL' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Build request
    const fetchOptions: RequestInit = {
      method: method || 'GET',
      headers: headers || {},
      signal: AbortSignal.timeout(timeout || 30000),
    };

    // Add body based on type
    if (data && method !== 'GET' && method !== 'HEAD') {
      if (bodyType === 'json') {
        fetchOptions.body = JSON.stringify(data);
      } else if (bodyType === 'text') {
        fetchOptions.body = data;
      } else if (bodyType === 'form-urlencoded') {
        fetchOptions.body = new URLSearchParams(data).toString();
      }
      // Note: form-data and binary require special handling in Workers
    }

    const response = await fetch(url, fetchOptions);

    // Read response
    const responseBody = await response.text();
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return new Response(
      JSON.stringify({
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: responseBody,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}

// gRPC Proxy Handler
async function handleGrpcProxy(request: Request, corsHeaders: Record<string, string>): Promise<Response> {
  try {
    const body = await request.json();
    const { url, service, method, message, metadata, timeout } = body;

    // Validate inputs
    if (!url || !service || !method || !message) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate URL (SSRF protection)
    if (!validateURL(url)) {
      return new Response(
        JSON.stringify({ error: 'Invalid or unsafe URL' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Build Connect protocol request
    const grpcUrl = `${url}/${service}/${method}`;
    const grpcHeaders = {
      'Content-Type': 'application/json',
      ...metadata,
    };

    const response = await fetch(grpcUrl, {
      method: 'POST',
      headers: grpcHeaders,
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(timeout || 30000),
    });

    const responseBody = await response.text();
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return new Response(
      JSON.stringify({
        status: response.status,
        headers: responseHeaders,
        body: responseBody,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}

// gRPC Reflection Handler
async function handleGrpcReflection(request: Request, corsHeaders: Record<string, string>): Promise<Response> {
  try {
    const body = await request.json();
    const { url, timeout } = body;

    if (!url) {
      return new Response(
        JSON.stringify({ error: 'URL is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate URL
    if (!validateURL(url)) {
      return new Response(
        JSON.stringify({ error: 'Invalid or unsafe URL' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Try v1 reflection
    const v1Url = `${url}/grpc.reflection.v1.ServerReflection/ServerReflectionInfo`;
    const v1Response = await fetch(v1Url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listServices: '' }),
      signal: AbortSignal.timeout(timeout || 30000),
    });

    if (v1Response.ok) {
      const data = await v1Response.text();
      return new Response(
        JSON.stringify({ version: 'v1', data }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Fallback to v1alpha
    const v1alphaUrl = `${url}/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo`;
    const v1alphaResponse = await fetch(v1alphaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listServices: '' }),
      signal: AbortSignal.timeout(timeout || 30000),
    });

    if (v1alphaResponse.ok) {
      const data = await v1alphaResponse.text();
      return new Response(
        JSON.stringify({ version: 'v1alpha', data }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ error: 'Reflection not supported' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}

// SSRF Protection
function validateURL(urlString: string): boolean {
  try {
    const url = new URL(urlString);

    // Only allow http and https
    if (!['http:', 'https:'].includes(url.protocol)) {
      return false;
    }

    // Block private/local addresses
    const hostname = url.hostname.toLowerCase();
    const blockedPatterns = [
      'localhost',
      '127.0.0.1',
      '0.0.0.0',
      '::1',
      '169.254.', // Link-local
      '10.',      // Private
      '172.16.',  // Private
      '192.168.', // Private
    ];

    return !blockedPatterns.some(pattern => hostname.includes(pattern));
  } catch {
    return false;
  }
}
