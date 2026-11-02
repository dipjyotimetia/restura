import { z } from 'zod';
import { FileContentSchema, FilePathSchema } from './core';

// fs:* paths: absolute, no `..` (the kernel resolves it after following symlinks)
const FS_ABS = /^(?:[\\/]|[A-Za-z]:[\\/])/;
export const FsPathSchema = FilePathSchema.refine(
  (p) => FS_ABS.test(p) && !p.split(/[\\/]/).includes('..'),
  'Path must be absolute without ".." segments'
);

// Schema for fs:writeFile which takes both filePath and content
export const WriteFileSchema = z.tuple([FsPathSchema, FileContentSchema]);
