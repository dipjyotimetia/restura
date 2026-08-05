/**
 * Node-only OWS SDK boundary. The upstream SDK uses Ajv's dynamic code
 * generator, which Electron's renderer CSP correctly forbids. Keep full SDK
 * parsing/normalization/validation/graph construction in Node workspace and
 * CLI paths; the renderer uses the safe profile module for its own inputs.
 */
import { buildGraph, Classes, type Graph, WorkflowValidationError } from '@openworkflowspec/sdk';
import type { OwsWorkflow } from './workflow-profile';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sdkError(prefix: string, error: unknown): Error {
  const message = error instanceof WorkflowValidationError ? error.message : String(error);
  return new Error(`${prefix}: ${message}`);
}

export function parseOwsWorkflowJsonWithSdk(source: string): OwsWorkflow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error('OWS workflows must be JSON.');
  }
  if (!isRecord(parsed) || !isRecord(parsed.document) || !Array.isArray(parsed.do)) {
    throw new Error('Expected an OWS workflow document.');
  }
  try {
    const normalized = new Classes.Workflow(parsed as OwsWorkflow).normalize() as OwsWorkflow;
    new Classes.Workflow(normalized).validate();
    return normalized;
  } catch (error) {
    throw sdkError('Invalid OWS workflow', error);
  }
}

export function parseOwsWorkflowImportWithSdk(source: string): OwsWorkflow {
  try {
    const imported = Classes.Workflow.deserialize(source).normalize() as OwsWorkflow;
    new Classes.Workflow(imported).validate();
    return imported;
  } catch (error) {
    throw sdkError('Invalid OWS workflow import', error);
  }
}

export function normalizeOwsWorkflowWithSdk(workflow: OwsWorkflow): OwsWorkflow {
  try {
    const normalized = new Classes.Workflow(workflow).normalize() as OwsWorkflow;
    new Classes.Workflow(normalized).validate();
    return normalized;
  } catch (error) {
    throw sdkError('Invalid OWS workflow', error);
  }
}

export function serializeOwsWorkflowJsonWithSdk(workflow: OwsWorkflow): string {
  return Classes.Workflow.serialize(normalizeOwsWorkflowWithSdk(workflow), 'json');
}

export function buildOwsGraphWithSdk(workflow: OwsWorkflow): Graph {
  return buildGraph(normalizeOwsWorkflowWithSdk(workflow));
}
