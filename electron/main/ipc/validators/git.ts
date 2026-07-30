import { z } from 'zod';

export const GitDirectoryInputSchema = z.object({
  directoryPath: z.string().min(1).max(2048),
});

export const GitDiffInputSchema = GitDirectoryInputSchema.extend({
  filePath: z.string().min(1).max(2048),
  staged: z.boolean().optional(),
});

export const GitLogInputSchema = GitDirectoryInputSchema.extend({
  limit: z.number().int().min(1).max(500).optional(),
});

export const GitAddFilesInputSchema = GitDirectoryInputSchema.extend({
  filePaths: z.array(z.string().min(1).max(2048)).min(1).max(1000),
});

export const GitCommitInputSchema = GitDirectoryInputSchema.extend({
  message: z.string().min(1).max(5000),
  all: z.boolean().optional(),
  paths: z.array(z.string().min(1).max(2048)).max(1000).optional(),
});

const GitRefNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._\-/]+$/)
  .refine(
    (name) =>
      !name.startsWith('-') && !name.includes('..') && !name.includes('@{') && !name.includes(':')
  );

export const GitRefInputSchema = GitDirectoryInputSchema.extend({
  name: GitRefNameSchema,
});

export const GitCloneInputSchema = z.object({
  parentDirectory: z.string().min(1).max(2048),
  remoteUrl: z.string().min(1).max(2048),
  directoryName: z.string().min(1).max(255),
});

export const GitMergeStartSchema = GitDirectoryInputSchema.extend({
  sourceRef: GitRefNameSchema,
  expectedSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i),
});

export const GitMergeConflictSchema = GitDirectoryInputSchema.extend({
  conflictId: z.string().regex(/^[0-9a-f]{64}$/i),
});

export const GitMergeResolutionSchema = GitDirectoryInputSchema.extend({
  resolution: z.discriminatedUnion('kind', [
    z.object({
      conflictId: z.string().regex(/^[0-9a-f]{64}$/i),
      kind: z.literal('content'),
      content: z.string().max(2 * 1024 * 1024),
    }),
    z.object({
      conflictId: z.string().regex(/^[0-9a-f]{64}$/i),
      kind: z.literal('choice'),
      choice: z.enum(['base', 'local', 'incoming', 'delete']),
    }),
  ]),
});

export const GitMergeCompleteSchema = GitDirectoryInputSchema.extend({
  message: z.string().min(1).max(5000),
});
