// Streaming HTTP request support using ReadableStream

export interface StreamingRequestOptions {
  url: string;
  method: string;
  headers?: Record<string, string>;
  onProgress?: (sent: number, total: number) => void;
  signal?: AbortSignal;
}

export interface StreamingChunk {
  data: string | ArrayBuffer;
  delay?: number; // Delay in ms before sending this chunk
}

// Create a readable stream from chunks
export function createChunkedStream(
  chunks: StreamingChunk[],
  onProgress?: (sent: number, total: number) => void
): ReadableStream<Uint8Array> {
  let chunkIndex = 0;
  let totalSent = 0;
  const totalSize = chunks.reduce((sum, chunk) => {
    if (typeof chunk.data === 'string') {
      return sum + new TextEncoder().encode(chunk.data).length;
    }
    return sum + chunk.data.byteLength;
  }, 0);

  return new ReadableStream({
    async pull(controller) {
      if (chunkIndex >= chunks.length) {
        controller.close();
        return;
      }

      const chunk = chunks[chunkIndex];
      if (!chunk) {
        controller.close();
        return;
      }

      // Wait for delay if specified
      if (chunk.delay && chunk.delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, chunk.delay));
      }

      // Convert data to Uint8Array
      let data: Uint8Array;
      if (typeof chunk.data === 'string') {
        data = new TextEncoder().encode(chunk.data);
      } else {
        data = new Uint8Array(chunk.data);
      }

      controller.enqueue(data);
      totalSent += data.length;
      chunkIndex++;

      if (onProgress) {
        onProgress(totalSent, totalSize);
      }
    },
  });
}

// Send a streaming request
export async function sendStreamingRequest(
  options: StreamingRequestOptions,
  stream: ReadableStream<Uint8Array>
): Promise<Response> {
  const { url, method, headers = {}, signal } = options;

  // Note: Browser fetch with streaming body requires certain conditions:
  // - Method must be POST, PUT, or PATCH
  // - duplex: 'half' must be set
  const response = await fetch(url, {
    method,
    headers: {
      ...headers,
    },
    body: stream,
    signal,
    // @ts-expect-error - duplex is not in the standard fetch types yet
    duplex: 'half',
  });

  return response;
}

// Parse a line-delimited stream (e.g., NDJSON)
export async function* parseLineDelimitedStream(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        // Yield any remaining data
        if (buffer.trim()) {
          yield buffer.trim();
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          yield line.trim();
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// Stream a file in chunks
export function createFileStream(
  file: File,
  chunkSize: number = 64 * 1024, // 64KB chunks
  onProgress?: (sent: number, total: number) => void
): ReadableStream<Uint8Array> {
  let offset = 0;
  const total = file.size;

  return new ReadableStream({
    async pull(controller) {
      if (offset >= total) {
        controller.close();
        return;
      }

      const chunk = file.slice(offset, offset + chunkSize);
      const arrayBuffer = await chunk.arrayBuffer();
      const data = new Uint8Array(arrayBuffer);

      controller.enqueue(data);
      offset += data.length;

      if (onProgress) {
        onProgress(offset, total);
      }
    },
  });
}

// Concatenate multiple streams
export function concatenateStreams(
  streams: ReadableStream<Uint8Array>[]
): ReadableStream<Uint8Array> {
  let currentIndex = 0;
  let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  return new ReadableStream({
    async pull(controller) {
      while (currentIndex < streams.length) {
        const currentStream = streams[currentIndex];
        if (!currentStream) {
          currentIndex++;
          continue;
        }

        if (!currentReader) {
          currentReader = currentStream.getReader();
        }

        const { done, value } = await currentReader.read();

        if (done) {
          currentReader.releaseLock();
          currentReader = null;
          currentIndex++;
          continue;
        }

        controller.enqueue(value);
        return;
      }

      controller.close();
    },

    cancel() {
      if (currentReader) {
        currentReader.cancel();
      }
    },
  });
}

// Check if browser supports streaming request bodies
export function supportsStreamingRequests(): boolean {
  try {
    // Check for ReadableStream and fetch with body stream support
    return (
      typeof ReadableStream !== 'undefined' &&
      typeof Request !== 'undefined' &&
      'body' in Request.prototype
    );
  } catch {
    return false;
  }
}
