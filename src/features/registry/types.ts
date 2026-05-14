import type { ComponentType } from 'react';
import type { Request, Response, RequestType } from '@/types';

export interface RunContext {
  signal: AbortSignal;
  variables: Record<string, string>;
}

export interface ProtocolModule {
  /** Stable id used in URLs, code generators, analytics */
  id: string;
  /** Display label in mode picker */
  label: string;
  /** Which `Request` discriminator this protocol uses */
  tabType: RequestType;
  /** React component rendered as the request builder (registered later) */
  Builder?: ComponentType<{ request: Request; onChange: (next: Request) => void }>;
  /** Construct a default empty Request for this protocol */
  defaultRequest: () => Request;
  /** Execute the request and resolve to a Response (or throw) */
  runRequest: (request: Request, ctx: RunContext) => Promise<Response>;
  /** Optional: code-generator entries this protocol contributes */
  codeGenerators?: Record<string, (request: Request) => string>;
}

export interface ProtocolRegistry {
  register(module: ProtocolModule): void;
  get(id: string): ProtocolModule | undefined;
  list(): ProtocolModule[];
}
