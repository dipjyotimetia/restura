import { describe, expect, it } from 'vitest';
import {
  migrateConnectionTemplates,
  moveTemplate,
  mqttTemplateSchema,
  newTemplateId,
  nextTemplateName,
  removeTemplate,
  renameTemplate,
  sanitizeTemplates,
  socketIOTemplateSchema,
  type WebSocketMessageTemplate,
  webSocketTemplateSchema,
} from '../messageTemplates';

const t = (id: string, name = id): WebSocketMessageTemplate => ({
  id,
  name,
  body: `{{${id}}}`,
  format: 'text',
});

describe('template list helpers', () => {
  it('renames, trimming, and ignores blank names', () => {
    const list = [t('a'), t('b')];
    expect(renameTemplate(list, 'b', '  Hello ')[1]?.name).toBe('Hello');
    expect(renameTemplate(list, 'b', '   ')).toEqual(list);
  });

  it('removes by id', () => {
    expect(removeTemplate([t('a'), t('b')], 'a').map((x) => x.id)).toEqual(['b']);
  });

  it('reorders up and down, clamping at the ends', () => {
    const list = [t('a'), t('b'), t('c')];
    expect(moveTemplate(list, 'c', -1).map((x) => x.id)).toEqual(['a', 'c', 'b']);
    expect(moveTemplate(list, 'a', 1).map((x) => x.id)).toEqual(['b', 'a', 'c']);
    expect(moveTemplate(list, 'a', -1).map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(moveTemplate(list, 'c', 1).map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(moveTemplate(list, 'zz', 1).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('picks the first free default name', () => {
    expect(nextTemplateName([], 'Message')).toBe('Message 1');
    expect(nextTemplateName([t('a', 'Message 2')], 'Message')).toBe('Message 3');
  });

  it('generates unique ids', () => {
    expect(newTemplateId()).not.toBe(newTemplateId());
  });
});

describe('sanitizeTemplates', () => {
  it('returns [] for non-arrays and drops malformed entries', () => {
    expect(sanitizeTemplates(undefined, webSocketTemplateSchema)).toEqual([]);
    expect(sanitizeTemplates({}, webSocketTemplateSchema)).toEqual([]);
    expect(
      sanitizeTemplates(
        [t('ok'), { id: 'bad', name: 'x', body: 1, format: 'text' }, { ...t('f'), format: 'xml' }],
        webSocketTemplateSchema
      )
    ).toEqual([t('ok')]);
  });

  it('validates Socket.IO and MQTT shapes', () => {
    expect(
      sanitizeTemplates(
        [{ id: '1', name: 'e', eventName: 'chat', args: '["{{x}}"]', ack: true }],
        socketIOTemplateSchema
      )
    ).toHaveLength(1);
    expect(
      sanitizeTemplates(
        [
          { id: '1', name: 'p', topic: 't', payload: '{{p}}', qos: 1, retain: false },
          { id: '2', name: 'p', topic: 't', payload: '', qos: 3, retain: false },
        ],
        mqttTemplateSchema
      )
    ).toHaveLength(1);
  });
});

describe('migrateConnectionTemplates', () => {
  it('adds a sanitized templates array to every persisted connection', () => {
    const out = migrateConnectionTemplates(
      {
        connections: {
          legacy: { id: 'legacy', url: 'wss://x' },
          withTemplates: { id: 'w', templates: [t('a'), { nope: true }] },
          broken: null,
        },
        activeConnectionId: 'legacy',
      },
      webSocketTemplateSchema
    ) as { connections: Record<string, { templates?: unknown }>; activeConnectionId: string };
    expect(out.connections.legacy?.templates).toEqual([]);
    expect(out.connections.withTemplates?.templates).toEqual([t('a')]);
    expect(out.connections.broken).toBeNull();
    expect(out.activeConnectionId).toBe('legacy');
  });

  it('passes through states without connections', () => {
    expect(migrateConnectionTemplates(null, webSocketTemplateSchema)).toBeNull();
    expect(migrateConnectionTemplates({ a: 1 }, webSocketTemplateSchema)).toEqual({ a: 1 });
  });
});
