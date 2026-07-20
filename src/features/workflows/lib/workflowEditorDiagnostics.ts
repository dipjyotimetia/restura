import {
  type OwsBindingIssue,
  validateOwsArtifactBindings,
  validateOwsBindings,
} from '@shared/ows/bindings';
import { type OwsWorkflow, validateOwsProfile } from '@shared/ows/workflow-profile';
import {
  findNodeAtLocation,
  type ParseError,
  parse,
  parseTree,
  printParseErrorCode,
} from 'jsonc-parser';

export interface JsonSourceRange {
  start: number;
  end: number;
}

export interface WorkflowEditorDiagnostic {
  category: 'syntax' | 'profile' | 'bindings' | 'artifact';
  path: string;
  message: string;
  range: JsonSourceRange | null;
}

function escapePointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function pointerSegments(pointer: string): Array<string | number> {
  if (!pointer || pointer === '/') return [];
  return pointer
    .split('/')
    .slice(1)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .map((segment) => (/^(0|[1-9]\d*)$/.test(segment) ? Number(segment) : segment));
}

function diagnosticRange(source: string, path: string): JsonSourceRange | null {
  const root = parseTree(source, []);
  if (!root) return null;
  const segments = pointerSegments(path);
  for (let count = segments.length; count >= 0; count -= 1) {
    const candidate = findNodeAtLocation(root, segments.slice(0, count));
    if (candidate) {
      return { start: candidate.offset, end: candidate.offset + candidate.length };
    }
  }
  return { start: root.offset, end: root.offset + root.length };
}

export function getJsonPointerRange(source: string, pointer: string): JsonSourceRange | null {
  return diagnosticRange(source, pointer);
}

function syntaxDiagnostics(source: string): WorkflowEditorDiagnostic[] {
  const errors: ParseError[] = [];
  parseTree(source, errors);
  return errors.map((error) => ({
    category: 'syntax',
    path: '',
    message: `Invalid JSON: ${printParseErrorCode(error.error)}`,
    range: { start: error.offset, end: Math.max(error.offset + error.length, error.offset + 1) },
  }));
}

function issuesToDiagnostics(
  source: string,
  issues: readonly OwsBindingIssue[],
  category: 'bindings' | 'artifact'
): WorkflowEditorDiagnostic[] {
  return issues.map((issue) => ({
    category,
    path: issue.path,
    message: issue.message,
    range: diagnosticRange(source, issue.path),
  }));
}

export function getWorkflowProfileDiagnostics(source: string): WorkflowEditorDiagnostic[] {
  const syntax = syntaxDiagnostics(source);
  if (syntax.length > 0) return syntax;
  const parsed = parse(source);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [
      {
        category: 'profile',
        path: '/',
        message: 'OWS workflow document must be an object.',
        range: diagnosticRange(source, '/'),
      },
    ];
  }
  const workflow = parsed as OwsWorkflow;
  const profile = validateOwsProfile(workflow);
  if (profile.ok) return [];
  return profile.issues.map((issue) => ({
    category: 'profile',
    path: issue.path,
    message: issue.message,
    range: diagnosticRange(source, issue.path),
  }));
}

export function getWorkflowBindingsDiagnostics(
  bindingsSource: string,
  workflowSource: string
): WorkflowEditorDiagnostic[] {
  const syntax = syntaxDiagnostics(bindingsSource);
  if (syntax.length > 0) return syntax;
  const bindings = parse(bindingsSource);
  const bindingsValidation = validateOwsBindings(bindings);
  if (!bindingsValidation.ok) {
    return issuesToDiagnostics(bindingsSource, bindingsValidation.issues, 'bindings');
  }

  const workflowSyntax = syntaxDiagnostics(workflowSource);
  if (workflowSyntax.length > 0) return [];
  const parsedWorkflow = parse(workflowSource);
  if (!parsedWorkflow || typeof parsedWorkflow !== 'object' || Array.isArray(parsedWorkflow))
    return [];
  const workflow = parsedWorkflow as OwsWorkflow;
  const profile = validateOwsProfile(workflow);
  if (!profile.ok) return [];
  const artifactValidation = validateOwsArtifactBindings(workflow, bindings);
  return artifactValidation.ok
    ? []
    : issuesToDiagnostics(bindingsSource, artifactValidation.issues, 'artifact');
}

export function taskPathPointer(taskPath: string): string {
  return `/tasks/${escapePointerSegment(taskPath)}`;
}
