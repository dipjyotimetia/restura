import { z } from 'zod';

// ===========================
// Rate Limiting
// ===========================

/**
 * Rate limit configuration per channel
 * limit: max requests allowed in window
 * windowMs: time window in milliseconds
 */
interface RateLimitConfig {
  limit: number;
  windowMs: number;
}

/**
 * Rate limits for different IPC channels
 * Adjust these values based on expected usage patterns
 */
const RATE_LIMITS: Record<string, RateLimitConfig> = {
  // HTTP requests - allow burst of API testing
  'http:request': { limit: 100, windowMs: 1000 },

  // File operations - moderate limits
  'fs:readFile': { limit: 50, windowMs: 1000 },
  'fs:writeFile': { limit: 20, windowMs: 1000 },
  'fs:selectFile': { limit: 10, windowMs: 1000 },
  'fs:selectDirectory': { limit: 10, windowMs: 1000 },
  'fs:saveFile': { limit: 20, windowMs: 1000 },

  // Store operations - higher limits for app state
  'store:set': { limit: 100, windowMs: 1000 },
  'store:get': { limit: 200, windowMs: 1000 },
  'store:delete': { limit: 50, windowMs: 1000 },

  // gRPC operations
  'grpc:request': { limit: 50, windowMs: 1000 },
  'grpc:reflect': { limit: 20, windowMs: 1000 },
  'grpc:send-message': { limit: 100, windowMs: 1000 },

  // Notification operations - prevent spam
  'notification:show': { limit: 5, windowMs: 1000 },

  // Shell operations - very restrictive
  'shell:openExternal': { limit: 5, windowMs: 1000 },

  // Collection operations
  'collections:list': { limit: 30, windowMs: 1000 },
  'collections:get': { limit: 50, windowMs: 1000 },
  'collections:save': { limit: 20, windowMs: 1000 },
  'collections:delete': { limit: 10, windowMs: 1000 },
};

/**
 * Rate limiter using sliding window algorithm
 */
class IPCRateLimiter {
  private counters = new Map<string, { count: number; windowStart: number }>();

  /**
   * Check if a request to the given channel is allowed
   * Returns true if allowed, false if rate limited
   */
  isAllowed(channel: string): boolean {
    const config = RATE_LIMITS[channel];

    // If no rate limit configured, allow all requests
    if (!config) return true;

    const now = Date.now();
    const counter = this.counters.get(channel);

    // First request or window expired - reset counter
    if (!counter || now - counter.windowStart >= config.windowMs) {
      this.counters.set(channel, { count: 1, windowStart: now });
      return true;
    }

    // Check if within limit
    if (counter.count >= config.limit) {
      console.warn(`[Rate Limit] Channel ${channel} exceeded limit (${config.limit}/${config.windowMs}ms)`);
      return false;
    }

    // Increment counter
    counter.count++;
    return true;
  }

  /**
   * Get remaining requests for a channel
   */
  getRemaining(channel: string): number {
    const config = RATE_LIMITS[channel];
    if (!config) return Infinity;

    const counter = this.counters.get(channel);
    if (!counter) return config.limit;

    const now = Date.now();
    if (now - counter.windowStart >= config.windowMs) {
      return config.limit;
    }

    return Math.max(0, config.limit - counter.count);
  }

  /**
   * Reset the rate limiter (useful for testing)
   */
  reset(): void {
    this.counters.clear();
  }

  /**
   * Get rate limit config for a channel (for informational purposes)
   */
  getConfig(channel: string): RateLimitConfig | undefined {
    return RATE_LIMITS[channel];
  }
}

// Singleton rate limiter instance
export const rateLimiter = new IPCRateLimiter();

/**
 * Error thrown when rate limit is exceeded
 */
export class RateLimitError extends Error {
  constructor(
    channel: string,
    public readonly retryAfterMs: number
  ) {
    super(`Rate limit exceeded for ${channel}. Try again in ${Math.ceil(retryAfterMs)}ms`);
    this.name = 'RateLimitError';
  }
}

// ===========================
// HTTP Request Schemas
// ===========================

const ProxyConfigSchema = z.object({
  enabled: z.boolean(),
  type: z.string(),
  host: z.string(),
  port: z.number().int().positive(),
  auth: z
    .object({
      username: z.string(),
      password: z.string(),
    })
    .optional(),
});

export const HttpRequestConfigSchema = z.object({
  method: z.string(),
  url: z.string().url('Invalid URL format'),
  headers: z.record(z.string()).optional(),
  params: z.record(z.string()).optional(),
  data: z.string().optional(),
  timeout: z.number().int().positive().optional(),
  maxRedirects: z.number().int().min(0).optional(),
  proxy: ProxyConfigSchema.optional(),
  verifySsl: z.boolean().optional(),
});

export type HttpRequestConfig = z.infer<typeof HttpRequestConfigSchema>;

// ===========================
// gRPC Request Schemas
// ===========================

export const GrpcRequestConfigSchema = z.object({
  id: z.string().optional(),
  url: z.string().url('Invalid gRPC URL'),
  service: z.string().min(1, 'Service name is required'),
  method: z.string().min(1, 'Method name is required'),
  methodType: z.enum(['unary', 'server-streaming', 'client-streaming', 'bidirectional-streaming']),
  metadata: z.record(z.string()),
  message: z.unknown(),
  protoContent: z.string().min(1, 'Proto content is required'),
  protoFileName: z.string().min(1, 'Proto file name is required'),
});

export type GrpcRequestConfig = z.infer<typeof GrpcRequestConfigSchema>;

// ===========================
// File Operations Schemas
// ===========================

export const DialogOptionsSchema = z.object({
  filters: z
    .array(
      z.object({
        name: z.string(),
        extensions: z.array(z.string()),
      })
    )
    .optional(),
  defaultPath: z.string().optional(),
});

export const FilePathSchema = z.string().min(1, 'File path is required').max(4096, 'File path too long');

export const FileContentSchema = z.string().max(50 * 1024 * 1024, 'File content exceeds 50MB limit');

// Schema for fs:writeFile which takes both filePath and content
export const WriteFileSchema = z.tuple([FilePathSchema, FileContentSchema]);

export const AppPathNameSchema = z.enum([
  'home',
  'appData',
  'userData',
  'cache',
  'temp',
  'exe',
  'module',
  'desktop',
  'documents',
  'downloads',
  'music',
  'pictures',
  'videos',
  'recent',
  'logs',
  'crashDumps',
]);

export const ShellUrlSchema = z.string().url('Invalid URL format').refine(
  (url) => {
    // Only allow http, https, and mailto protocols
    const protocol = new URL(url).protocol;
    return ['http:', 'https:', 'mailto:'].includes(protocol);
  },
  { message: 'Only http, https, and mailto URLs are allowed' }
);

// ===========================
// Notification Schemas
// ===========================

export const NotificationOptionsSchema = z.object({
  title: z.string().min(1, 'Title is required').max(256, 'Title too long'),
  body: z.string().min(1, 'Body is required').max(1024, 'Body too long'),
  silent: z.boolean().optional(),
  icon: z.string().optional(),
  urgency: z.enum(['normal', 'critical', 'low']).optional(),
});

export const NotificationVersionSchema = z.string().regex(/^\d+\.\d+\.\d+/, 'Invalid version format');

export const NotificationMessageSchema = z.string().min(1, 'Message is required').max(1024, 'Message too long');

export const NotificationRequestCompleteSchema = z.object({
  status: z.number().int(),
  time: z.number(),
  url: z.string().url('Invalid URL format'),
});

// ===========================
// gRPC Stream Schemas
// ===========================

export const GrpcStreamRequestIdSchema = z.string().min(1, 'Request ID is required');

export const GrpcStreamMessageSchema = z.unknown(); // Allow any message structure

// Schema for grpc:send-message which takes both requestId and message
export const GrpcSendMessageSchema = z.tuple([GrpcStreamRequestIdSchema, GrpcStreamMessageSchema]);

// ===========================
// Store Schemas
// ===========================

/**
 * Store key schema - validates keys used in electron-store
 * Prevents injection and ensures keys are reasonable
 */
export const StoreKeySchema = z
  .string()
  .min(1, 'Store key is required')
  .max(256, 'Store key too long (max 256 characters)')
  .regex(/^[a-zA-Z0-9_.-]+$/, 'Store key contains invalid characters (allowed: a-z, A-Z, 0-9, _, ., -)');

/**
 * Store value schema - validates values stored in electron-store
 * Limits size to prevent memory issues
 */
export const StoreValueSchema = z.string().max(10 * 1024 * 1024, 'Store value exceeds 10MB limit');

/**
 * Combined schema for store:set which takes both key and value
 */
export const StoreSetSchema = z.tuple([StoreKeySchema, StoreValueSchema]);

// ===========================
// Validation Helper
// ===========================

/**
 * Validates IPC input using a Zod schema
 * Throws a descriptive error if validation fails
 */
export function validateIpcInput<T>(schema: z.ZodSchema<T>, data: unknown, channel: string): T {
  try {
    return schema.parse(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.errors.map((err) => `${err.path.join('.')}: ${err.message}`).join(', ');

      console.error(`[IPC Validation Error] Channel: ${channel}`, {
        errors: error.errors,
        receivedData: data,
      });

      throw new Error(`Invalid IPC payload for ${channel}: ${errorMessages}`);
    }
    throw error;
  }
}

/**
 * Options for creating a validated handler
 */
interface ValidatedHandlerOptions {
  /** Skip rate limiting for this handler */
  skipRateLimit?: boolean;
}

/**
 * Creates a validated IPC handler with automatic error handling and rate limiting
 */
export function createValidatedHandler<TInput, TOutput>(
  channel: string,
  schema: z.ZodSchema<TInput>,
  handler: (input: TInput) => Promise<TOutput> | TOutput,
  options: ValidatedHandlerOptions = {}
): (_event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<TOutput> {
  return async (_event, ...args) => {
    // Apply rate limiting unless skipped
    if (!options.skipRateLimit && !rateLimiter.isAllowed(channel)) {
      const config = rateLimiter.getConfig(channel);
      throw new RateLimitError(channel, config?.windowMs ?? 1000);
    }

    // For handlers with single argument, validate it directly
    // For handlers with multiple arguments, validate the first one
    const input = args.length === 1 ? args[0] : args;
    const validated = validateIpcInput(schema, input, channel);
    return handler(validated as TInput);
  };
}

/**
 * Creates a rate-limited IPC handler WITHOUT schema validation
 * Use this for handlers that don't need input validation but should be rate limited
 */
export function createRateLimitedHandler<TOutput>(
  channel: string,
  handler: (...args: unknown[]) => Promise<TOutput> | TOutput
): (_event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<TOutput> {
  return async (_event, ...args) => {
    if (!rateLimiter.isAllowed(channel)) {
      const config = rateLimiter.getConfig(channel);
      throw new RateLimitError(channel, config?.windowMs ?? 1000);
    }
    return handler(...args);
  };
}

/**
 * Creates a validated IPC listener (for ipcMain.on) with automatic error handling
 */
export function createValidatedListener<TInput>(
  channel: string,
  schema: z.ZodSchema<TInput>,
  handler: (event: Electron.IpcMainEvent, input: TInput) => void
): (event: Electron.IpcMainEvent, ...args: unknown[]) => void {
  return (event, ...args) => {
    try {
      const input = args.length === 1 ? args[0] : args;
      const validated = validateIpcInput(schema, input, channel);
      handler(event, validated as TInput);
    } catch (error) {
      console.error(`[IPC Listener Error] Channel: ${channel}`, error);
      // For .on() handlers, we can't return errors, so we just log
    }
  };
}
