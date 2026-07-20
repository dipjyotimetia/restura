/**
 * Offline JSON schemas for the Advanced workflow editors. These describe the
 * executable Restura profile, not the broader upstream OWS surface. The
 * profile validator remains the authoritative fail-closed gate at save/run.
 */
import { OWS_RESOURCE_ID_PATTERN, OWS_TASK_PATH_PATTERN } from '@shared/ows/bindings';
import { OWS_SEMVER_PATTERN, OWS_TASK_NAME_PATTERN } from '@shared/ows/workflow-profile';

export const WORKFLOW_SCHEMA_URI = 'restura://schemas/workflow.ows.safe.schema.json';
export const BINDINGS_SCHEMA_URI = 'restura://schemas/workflow.bindings.safe.schema.json';

const SAFE_PROPERTY_NAME = {
  not: { enum: ['__proto__', 'constructor', 'prototype'] },
};

const IDENTIFIER = {
  allOf: [{ pattern: '^[A-Za-z_$][\\w$]*$' }, SAFE_PROPERTY_NAME],
};

const JSON_VALUE = {
  anyOf: [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'null' },
    { type: 'array', items: { $ref: '#/definitions/jsonValue' } },
    {
      type: 'object',
      propertyNames: SAFE_PROPERTY_NAME,
      additionalProperties: { $ref: '#/definitions/jsonValue' },
    },
  ],
};

const DURATION = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: {
    days: { type: 'number', minimum: 0 },
    hours: { type: 'number', minimum: 0 },
    minutes: { type: 'number', minimum: 0 },
    seconds: { type: 'number', minimum: 0 },
    milliseconds: { type: 'number', minimum: 0 },
  },
};

const TIMEOUT = {
  type: 'object',
  required: ['after'],
  additionalProperties: false,
  properties: { after: DURATION },
};

const TASK_OPTIONS = {
  if: { type: 'string' },
  timeout: TIMEOUT,
};

const TASK = {
  oneOf: [
    {
      type: 'object',
      required: ['call', 'with'],
      additionalProperties: false,
      properties: {
        ...TASK_OPTIONS,
        call: { const: 'http' },
        with: {
          type: 'object',
          required: ['method', 'endpoint'],
          additionalProperties: false,
          properties: {
            method: { enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] },
            endpoint: {
              type: 'object',
              required: ['uri'],
              additionalProperties: false,
              properties: { uri: { const: 'restura://saved-request' } },
            },
          },
        },
      },
    },
    {
      type: 'object',
      required: ['do'],
      additionalProperties: false,
      properties: { ...TASK_OPTIONS, do: { $ref: '#/definitions/taskList' } },
    },
    {
      type: 'object',
      required: ['set'],
      additionalProperties: false,
      properties: {
        ...TASK_OPTIONS,
        set: {
          type: 'object',
          minProperties: 1,
          propertyNames: SAFE_PROPERTY_NAME,
          additionalProperties: JSON_VALUE,
        },
      },
    },
    {
      type: 'object',
      required: ['wait'],
      additionalProperties: false,
      properties: { ...TASK_OPTIONS, wait: DURATION },
    },
    {
      type: 'object',
      required: ['for', 'do'],
      additionalProperties: false,
      properties: {
        ...TASK_OPTIONS,
        for: {
          type: 'object',
          required: ['each', 'in'],
          additionalProperties: false,
          properties: {
            each: { type: 'string', ...IDENTIFIER },
            at: { type: 'string', ...IDENTIFIER },
            in: {
              type: 'string',
              pattern: '^\\$\\{\\s*\\.?[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*\\s*\\}$',
            },
          },
        },
        do: { $ref: '#/definitions/taskList' },
      },
    },
    {
      type: 'object',
      required: ['try'],
      additionalProperties: false,
      properties: {
        ...TASK_OPTIONS,
        try: { $ref: '#/definitions/taskList' },
        catch: {
          type: 'object',
          additionalProperties: false,
          properties: {
            as: { type: 'string', ...IDENTIFIER },
            do: { $ref: '#/definitions/taskList' },
          },
        },
      },
    },
  ],
};

export const RESTURA_OWS_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: WORKFLOW_SCHEMA_URI,
  title: 'Restura-safe Open Workflow Specification',
  description:
    'Only Restura’s bounded, binding-only OWS profile is executable. Unsupported controls are intentionally absent.',
  type: 'object',
  required: ['document', 'do'],
  additionalProperties: false,
  properties: {
    document: {
      type: 'object',
      required: ['dsl', 'namespace', 'name', 'version'],
      additionalProperties: false,
      properties: {
        dsl: { const: '1.0.3', description: 'Restura supports OWS DSL 1.0.3.' },
        namespace: { type: 'string', pattern: '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$' },
        name: { type: 'string', pattern: '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$' },
        version: { type: 'string', pattern: OWS_SEMVER_PATTERN },
        title: { type: 'string' },
        summary: { type: 'string' },
        tags: {
          type: 'object',
          minProperties: 1,
          propertyNames: SAFE_PROPERTY_NAME,
          additionalProperties: JSON_VALUE,
        },
        metadata: {
          type: 'object',
          minProperties: 1,
          propertyNames: SAFE_PROPERTY_NAME,
          additionalProperties: JSON_VALUE,
        },
      },
    },
    do: { $ref: '#/definitions/taskList' },
    timeout: TIMEOUT,
    output: {
      type: 'object',
      required: ['as'],
      additionalProperties: false,
      properties: { as: JSON_VALUE },
    },
  },
  definitions: {
    jsonValue: JSON_VALUE,
    taskList: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        minProperties: 1,
        maxProperties: 1,
        propertyNames: { allOf: [{ pattern: OWS_TASK_NAME_PATTERN }, SAFE_PROPERTY_NAME] },
        additionalProperties: TASK,
      },
    },
  },
} as const;

export const RESTURA_BINDINGS_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: BINDINGS_SCHEMA_URI,
  title: 'Restura workflow bindings',
  description:
    'Bindings can only name approved saved HTTP or GraphQL requests. They never contain transport configuration, credentials, or executable behavior.',
  type: 'object',
  required: ['version', 'tasks'],
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    tasks: {
      type: 'object',
      propertyNames: { pattern: OWS_TASK_PATH_PATTERN },
      additionalProperties: {
        oneOf: [
          {
            type: 'object',
            required: ['kind', 'call', 'resourceId'],
            additionalProperties: false,
            properties: {
              kind: { const: 'saved-request' },
              call: { const: 'http' },
              resourceId: { type: 'string', pattern: OWS_RESOURCE_ID_PATTERN },
            },
          },
          {
            type: 'object',
            required: ['kind', 'call', 'protocol', 'resourceId'],
            additionalProperties: false,
            properties: {
              kind: { const: 'saved-request' },
              call: { const: 'http' },
              protocol: { const: 'graphql' },
              resourceId: { type: 'string', pattern: OWS_RESOURCE_ID_PATTERN },
            },
          },
        ],
      },
    },
  },
} as const;
