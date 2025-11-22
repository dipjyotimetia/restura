import { z } from 'zod';

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
 * Creates a validated IPC handler with automatic error handling
 */
export function createValidatedHandler<TInput, TOutput>(
  channel: string,
  schema: z.ZodSchema<TInput>,
  handler: (input: TInput) => Promise<TOutput> | TOutput
): (_event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<TOutput> {
  return async (_event, ...args) => {
    // For handlers with single argument, validate it directly
    // For handlers with multiple arguments, validate the first one
    const input = args.length === 1 ? args[0] : args;
    const validated = validateIpcInput(schema, input, channel);
    return handler(validated as TInput);
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
