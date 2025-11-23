/**
 * File Collection Schema
 *
 * Defines the YAML file format for Git-native collections.
 * Collections are stored as directories with YAML files:
 *
 * collection/
 *   _collection.yaml     # Collection metadata
 *   folder/
 *     _folder.yaml       # Folder metadata
 *     request.http.yaml  # HTTP request
 *     service.grpc.yaml  # gRPC request
 */

import { z } from 'zod';
import {
  keyValueSchema,
  authConfigSchema,
  requestSettingsSchema,
  httpMethodSchema,
} from './validations';

// File metadata added to track sync state
export interface FileMetadata {
  filePath: string;
  lastModified: number;
  checksum?: string;
}

// Collection file metadata stored in _collection.yaml
export const fileCollectionMetaSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  auth: authConfigSchema.optional(),
  variables: z.array(keyValueSchema.omit({ id: true })).optional(),
});

export type FileCollectionMeta = z.infer<typeof fileCollectionMetaSchema>;

// Folder metadata stored in _folder.yaml
export const fileFolderMetaSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

export type FileFolderMeta = z.infer<typeof fileFolderMetaSchema>;

// Key-value without ID (IDs are generated at load time)
export const fileKeyValueSchema = z.object({
  key: z.string(),
  value: z.string(),
  enabled: z.boolean().default(true),
  description: z.string().optional(),
});

export type FileKeyValue = z.infer<typeof fileKeyValueSchema>;

// Auth config for files (same as app)
export const fileAuthConfigSchema = authConfigSchema;

// HTTP request file format (stored as .http.yaml)
export const fileHttpRequestSchema = z.object({
  name: z.string().min(1),
  method: httpMethodSchema,
  url: z.string(),
  headers: z.array(fileKeyValueSchema).optional(),
  params: z.array(fileKeyValueSchema).optional(),
  body: z
    .object({
      type: z.enum([
        'none',
        'json',
        'xml',
        'form-data',
        'x-www-form-urlencoded',
        'binary',
        'text',
        'graphql',
        'protobuf',
        'multipart-mixed',
      ]),
      raw: z.string().optional(),
      formData: z.array(z.any()).optional(),
      binary: z.any().optional(),
      multipartParts: z.array(z.any()).optional(),
    })
    .optional(),
  auth: fileAuthConfigSchema.optional(),
  preRequestScript: z.string().optional(),
  testScript: z.string().optional(),
  settings: requestSettingsSchema.optional(),
});

export type FileHttpRequest = z.infer<typeof fileHttpRequestSchema>;

// gRPC request file format (stored as .grpc.yaml)
export const fileGrpcRequestSchema = z.object({
  name: z.string().min(1),
  methodType: z.enum(['unary', 'server-streaming', 'client-streaming', 'bidirectional-streaming']),
  url: z.string(),
  service: z.string(),
  method: z.string(),
  metadata: z.array(fileKeyValueSchema).optional(),
  message: z.string().optional(),
  auth: fileAuthConfigSchema.optional(),
  preRequestScript: z.string().optional(),
  testScript: z.string().optional(),
});

export type FileGrpcRequest = z.infer<typeof fileGrpcRequestSchema>;

// Union of file request types
export const fileRequestSchema = z.union([fileHttpRequestSchema, fileGrpcRequestSchema]);

export type FileRequest = z.infer<typeof fileRequestSchema>;

// Sync state for tracking file vs memory state
export type SyncState = 'synced' | 'modified' | 'conflict' | 'new' | 'deleted';

export interface FileSyncInfo {
  collectionId: string;
  directoryPath: string;
  lastSynced: number;
  state: SyncState;
  files: Map<string, FileMetadata>;
}

// Conflict resolution options
export type ConflictResolution = 'keep-local' | 'load-external' | 'keep-both';

export interface ConflictInfo {
  itemId: string;
  itemName: string;
  filePath: string;
  localModified: number;
  externalModified: number;
}

// File extension constants
export const FILE_EXTENSIONS = {
  COLLECTION_META: '_collection.yaml',
  FOLDER_META: '_folder.yaml',
  HTTP_REQUEST: '.http.yaml',
  GRPC_REQUEST: '.grpc.yaml',
} as const;

// Helper to determine request type from filename
export function getRequestTypeFromFilename(filename: string): 'http' | 'grpc' | null {
  if (filename.endsWith(FILE_EXTENSIONS.HTTP_REQUEST)) return 'http';
  if (filename.endsWith(FILE_EXTENSIONS.GRPC_REQUEST)) return 'grpc';
  return null;
}

// Helper to generate filename from request
export function getFilenameForRequest(name: string, type: 'http' | 'grpc'): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const extension = type === 'http' ? FILE_EXTENSIONS.HTTP_REQUEST : FILE_EXTENSIONS.GRPC_REQUEST;
  return `${sanitized}${extension}`;
}

// Helper to extract name from filename
export function getNameFromFilename(filename: string): string {
  return filename
    .replace(FILE_EXTENSIONS.HTTP_REQUEST, '')
    .replace(FILE_EXTENSIONS.GRPC_REQUEST, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
