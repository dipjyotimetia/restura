// Turn captured request traffic (history entries, saved collection requests)
// into eval dataset cases. Secrets are redacted with the SAME helpers the AI
// assistant uses before any request/response text reaches a model. Pure — the
// dialog supplies the raw history/collection items.
import { redactBody, redactHeaders } from '@shared/protocol/ai/redaction';
import type { DatasetCase } from '../types';
import type { KeyValue } from '@/types/common';
import type { HttpRequest, Response as HttpResponse } from '@/types/http';

/** A request paired with its (optional) captured response. */
export interface CapturedRequest {
  request: HttpRequest;
  response?: HttpResponse;
}

function headersToRecord(headers: KeyValue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) {
    if (h.enabled !== false && h.key) out[h.key] = h.value;
  }
  return out;
}

/** Best-effort textual request body (raw bodies only; binary/files skipped). */
function requestBodyText(req: HttpRequest): string {
  const b = req.body;
  if (!b || b.type === 'none') return '';
  if (typeof b.raw === 'string') return b.raw;
  return '';
}

/**
 * Map one captured request into a dataset case. The request fields become
 * `vars` (so a prompt template can reference `{{method}}`, `{{url}}`, …) and the
 * captured response body becomes the `reference`. All secret-bearing text is
 * redacted first.
 */
export function capturedRequestToCase(item: CapturedRequest): Omit<DatasetCase, 'id'> {
  const headers = redactHeaders(headersToRecord(item.request.headers), 'default');
  const body = redactBody(requestBodyText(item.request), 'default');
  const vars: Record<string, string> = {
    method: item.request.method,
    url: redactBody(item.request.url, 'default'),
    headers: JSON.stringify(headers),
    body,
  };
  const out: Omit<DatasetCase, 'id'> = { vars };
  if (item.response) {
    const refBody = redactBody(item.response.body ?? '', 'default');
    return { ...out, reference: refBody };
  }
  return out;
}

/** Map a list of captured requests into cases. */
export function capturedRequestsToCases(items: CapturedRequest[]): Array<Omit<DatasetCase, 'id'>> {
  return items.map(capturedRequestToCase);
}
