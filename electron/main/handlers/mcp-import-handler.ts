import * as crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import {
  MCP_IMPORT_LIMITS,
  McpConfigParseError,
  type ParsedMcpEntry,
  type ParsedMcpStdioEntry,
  parseMcpConfigText,
  sanitizeImportLabel,
} from '@shared/mcp-import/mcp-config-parser';
import {
  buildHttpDraft,
  isPlaceholderOnly,
  type McpImportDraft,
  type McpImportDraftRow,
  type McpImportPreviewSource,
  toPreviewEntry,
} from '@shared/mcp-import/mcp-import-model';
import { isSecretFieldName } from '@shared/secrets/key-value-redaction';
import { type BrowserWindow, dialog, ipcMain } from 'electron';
import { IPC } from '../../shared/channels';
import type { McpImportCommitResult, McpImportScanResult } from '../../types/api/protocols';
import { bindRendererCleanup } from '../ipc/connection-cleanup';
import { createKeyedRateLimiter, rateLimited } from '../ipc/ipc-rate-limiter';
import {
  createValidatedEventHandler,
  McpImportCommitSchema,
  McpImportScanSchema,
  McpStdioConnectSchema,
  StdioCwdSchema,
} from '../ipc/validators';
import {
  hasControlChars,
  isExecutionSensitiveEnvName,
  MCP_STDIO_LIMITS,
} from '../security/mcp-stdio-policy';
import { deleteSecretHandle, storeSecretHandle } from '../security/secret-handle-store';
import { displayPath, knownMcpConfigSources } from './mcp-import-paths';

// ===========================
// MCP config import (#906, ADR 0030) - desktop only
//
// Main reads the files, so file paths and secret env values never need to
// exist in the renderer: a scan returns a preview with secret values omitted,
// and a commit stores credential-named stdio env values as secret handles
// (ADR-0007) and returns only the handle. Nothing here can approve a stdio
// launch: the consent gate in mcp-stdio-consent.ts prompts on first connect
// exactly as for a hand-entered server.
// ===========================

const importRateLimiter = createKeyedRateLimiter(20, 60_000);
const SESSION_TTL_MS = 10 * 60_000;
const MAX_SESSIONS = 16;
const MAX_SESSIONS_PER_OWNER = 4;

interface ImportSession {
  ownerId: number;
  createdAt: number;
  /** key -> parsed entry (raw values, main only). */
  entries: Map<string, ParsedMcpEntry>;
  timer: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, ImportSession>();

function dropSession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  clearTimeout(session.timer);
  sessions.delete(id);
}

function addSession(ownerId: number, entries: Map<string, ParsedMcpEntry>): string {
  // Oldest first (Map preserves insertion order): evict per owner, then globally.
  const owned = [...sessions].filter(([, s]) => s.ownerId === ownerId);
  for (const [id] of owned.slice(0, Math.max(0, owned.length - MAX_SESSIONS_PER_OWNER + 1))) {
    dropSession(id);
  }
  while (sessions.size >= MAX_SESSIONS) dropSession(sessions.keys().next().value as string);
  const id = crypto.randomUUID();
  // An unref'd timer expires the session without keeping the app alive.
  const timer = setTimeout(() => dropSession(id), SESSION_TTL_MS);
  timer.unref();
  sessions.set(id, { ownerId, createdAt: Date.now(), entries, timer });
  return id;
}

/** A stdio env row becomes a secret handle only when it is safe to hide from the consent prompt. */
export function envIsHandleBacked(row: { name: string; value: string }): boolean {
  return (
    row.value !== '' &&
    row.value.length <= MCP_STDIO_LIMITS.envValueMaxLength &&
    !isPlaceholderOnly(row.value) &&
    // A value containing a Restura variable must stay plain so it can still resolve.
    !row.value.includes('{{') &&
    isSecretFieldName(row.name) &&
    !isExecutionSensitiveEnvName(row.name)
  );
}

/** Handle label from server + variable name only; never raw file text beyond the sanitised key. */
export function importHandleLabel(serverName: string, varName: string): string {
  const label = sanitizeImportLabel(`${serverName} ${varName.replace(/[^A-Za-z0-9_]/g, '_')}`, 120);
  return hasControlChars(label) || label === '' ? 'Imported MCP secret' : `MCP import: ${label}`;
}

async function readBounded(file: string, rejectSymlink: boolean): Promise<string> {
  if (rejectSymlink && (await fs.lstat(file)).isSymbolicLink()) {
    throw new McpConfigParseError('Symbolic links are not followed');
  }
  // O_NONBLOCK so opening a FIFO cannot hang; the type is checked on the fd.
  const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw new McpConfigParseError('Not a regular file');
    // Read at most maxBytes + 1 regardless of what stat said (the file can grow).
    const limit = MCP_IMPORT_LIMITS.maxBytes;
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > limit) {
      throw new McpConfigParseError(`Config is larger than ${limit / 1024} KB and was not read`);
    }
    return buffer.toString('utf8', 0, total);
  } finally {
    await handle.close();
  }
}

interface SourceFile {
  label: string;
  file: string;
  /** Detected locations that are absent are skipped silently. */
  optional: boolean;
  /** Detected files must be regular files, not symlinks (a picked file is the user's choice). */
  rejectSymlink?: boolean;
}

/** Read + parse files into preview sources and the main-only entry table. */
export async function scanSourceFiles(
  files: SourceFile[],
  home: string = os.homedir()
): Promise<{ sources: McpImportPreviewSource[]; entries: Map<string, ParsedMcpEntry> }> {
  const sources: McpImportPreviewSource[] = [];
  const entries = new Map<string, ParsedMcpEntry>();
  for (const [sourceIndex, src] of files.entries()) {
    const location = sanitizeImportLabel(displayPath(src.file, home), 300);
    let text: string;
    try {
      text = await readBounded(src.file, src.rejectSymlink === true);
    } catch (err) {
      if (src.optional && (err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      sources.push({
        label: src.label,
        location,
        formats: [],
        entries: [],
        inputs: [],
        warnings: [],
        error: err instanceof McpConfigParseError ? err.message : 'Could not read the file',
      });
      continue;
    }
    try {
      const parsed = parseMcpConfigText(text);
      const prefix = `${sourceIndex}.`;
      for (const entry of parsed.entries) entries.set(`${prefix}${entry.key}`, entry);
      sources.push({
        label: src.label,
        location,
        formats: parsed.formats,
        entries: parsed.entries.map((e) => toPreviewEntry(e, prefix, envIsHandleBacked)),
        inputs: parsed.inputs,
        warnings: parsed.warnings,
      });
    } catch (err) {
      // A settings.json without MCP servers is normal for detected files.
      if (src.optional && err instanceof McpConfigParseError && err.message.startsWith('No MCP')) {
        continue;
      }
      sources.push({
        label: src.label,
        location,
        formats: [],
        entries: [],
        inputs: [],
        warnings: [],
        error: err instanceof McpConfigParseError ? err.message : 'Could not parse the file',
      });
    }
  }
  return { sources, entries };
}

type StdioBuild = { draft: McpImportDraft; handleIds: string[] } | { reason: string };

/**
 * Validate a stdio entry against the same schema `mcp:connect` enforces, then
 * store credential-named env values as handles. Handles are rolled back when
 * anything fails, so an invalid entry leaves nothing behind.
 */
export function buildStdioDraft(entry: ParsedMcpStdioEntry): StdioBuild {
  const warnings = [...entry.warnings];
  const cwd = entry.cwd;
  const probeCwd = cwd !== undefined && StdioCwdSchema.safeParse(cwd).success;
  if (cwd !== undefined && !probeCwd) {
    warnings.push('Working directory was dropped because it is not an absolute path');
  }
  const validCwd = probeCwd ? cwd : undefined;

  const handleRows = entry.env.filter(envIsHandleBacked);
  const probeEnv: Record<string, unknown> = {};
  for (const row of entry.env) {
    probeEnv[row.name] = envIsHandleBacked(row)
      ? { kind: 'handle', id: 'pending', label: importHandleLabel(entry.name, row.name) }
      : row.value;
  }
  const probe = McpStdioConnectSchema.safeParse({
    connectionId: crypto.randomUUID(),
    transport: 'stdio',
    command: entry.command,
    args: entry.args,
    ...(validCwd !== undefined ? { cwd: validCwd } : {}),
    env: probeEnv,
  });
  if (!probe.success) {
    return { reason: sanitizeImportLabel(probe.error.issues[0]?.message ?? 'Invalid entry', 200) };
  }

  const stored: string[] = [];
  try {
    const env: McpImportDraftRow[] = entry.env.map((row) => {
      if (!handleRows.includes(row)) return { key: row.name, value: row.value };
      const label = importHandleLabel(entry.name, row.name);
      const { id } = storeSecretHandle({ value: row.value, label, scope: 'mcp-import' });
      stored.push(id);
      return {
        key: row.name,
        value: '',
        secret: true,
        secretRef: { kind: 'handle', id, label },
      };
    });
    return {
      handleIds: stored,
      draft: {
        name: entry.name,
        transport: 'stdio',
        url: '',
        headers: [],
        stdio: {
          command: entry.command,
          args: entry.args,
          ...(validCwd !== undefined ? { cwd: validCwd } : {}),
          env,
        },
        warnings,
      },
    };
  } catch (err) {
    for (const id of stored) deleteSecretHandle(id);
    throw err;
  }
}

export function commitEntries(
  entries: Map<string, ParsedMcpEntry>,
  keys: string[]
): McpImportCommitResult {
  const drafts: McpImportDraft[] = [];
  const skipped: McpImportCommitResult['skipped'] = [];
  const written: string[] = [];
  try {
    for (const key of new Set(keys)) {
      const entry = entries.get(key);
      if (!entry) {
        skipped.push({ key, name: '', reason: 'Not part of this scan' });
      } else if (entry.kind === 'invalid') {
        skipped.push({ key, name: entry.name, reason: entry.reason });
      } else if (entry.kind === 'http') {
        drafts.push(buildHttpDraft(entry));
      } else {
        const built = buildStdioDraft(entry);
        if ('draft' in built) {
          drafts.push(built.draft);
          written.push(...built.handleIds);
        } else {
          skipped.push({ key, name: entry.name, reason: built.reason });
        }
      }
    }
  } catch (err) {
    // A failed batch leaves no secret behind: nothing reached the renderer.
    for (const id of written) deleteSecretHandle(id);
    throw err;
  }
  return { drafts, skipped };
}

async function pickFile(getMainWindow: () => BrowserWindow | null): Promise<string | null> {
  const win = getMainWindow();
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    title: 'Import MCP servers',
    properties: ['openFile'],
    filters: [
      { name: 'MCP config (JSON)', extensions: ['json', 'jsonc'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  const [file] = result.filePaths;
  return result.canceled || !file ? null : file;
}

export function registerMcpImportIPC(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle(
    IPC.mcp.importScan,
    rateLimited(
      importRateLimiter,
      createValidatedEventHandler(
        IPC.mcp.importScan,
        McpImportScanSchema,
        async (input, event): Promise<McpImportScanResult> => {
          let files: SourceFile[];
          if (input.source === 'pick') {
            const file = await pickFile(getMainWindow);
            if (!file) return { sessionId: null, sources: [] };
            files = [{ label: 'Selected file', file, optional: false }];
          } else {
            files = knownMcpConfigSources(process.platform, os.homedir(), process.env.APPDATA).map(
              (s) => ({ ...s, optional: true, rejectSymlink: true })
            );
          }
          const { sources, entries } = await scanSourceFiles(files);
          if (entries.size === 0) return { sessionId: null, sources };
          const sessionId = addSession(event.sender.id, entries);
          bindRendererCleanup(sessions, event.sender, (deadId) => {
            for (const [id, s] of sessions) if (s.ownerId === deadId) dropSession(id);
          });
          return { sessionId, sources };
        }
      )
    )
  );

  ipcMain.handle(
    IPC.mcp.importCommit,
    rateLimited(
      importRateLimiter,
      createValidatedEventHandler(
        IPC.mcp.importCommit,
        McpImportCommitSchema,
        (input, event): McpImportCommitResult => {
          const session = sessions.get(input.sessionId);
          // Missing, expired and foreign sessions are indistinguishable.
          if (!session || session.ownerId !== event.sender.id) {
            throw new Error('Import session expired; scan again');
          }
          // The session survives a failed or fully-skipped commit (the dialog stays open for
          // a retry) and is spent only once at least one draft was produced.
          const result = commitEntries(session.entries, input.keys);
          if (result.drafts.length > 0) dropSession(input.sessionId);
          return result;
        }
      )
    )
  );
}

export function unregisterMcpImportIPC(): void {
  ipcMain.removeHandler(IPC.mcp.importScan);
  ipcMain.removeHandler(IPC.mcp.importCommit);
  for (const id of [...sessions.keys()]) dropSession(id);
}

/** Test seam. */
export function __mcpImportSessionCountForTests(): number {
  return sessions.size;
}
export function __seedMcpImportSessionForTests(
  ownerId: number,
  entries: Map<string, ParsedMcpEntry>
): string {
  return addSession(ownerId, entries);
}
