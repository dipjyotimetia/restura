// Foundational primitives shared across request/collection/settings domains.

// Key-Value Pair
export interface KeyValue {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  description?: string;
  secret?: boolean;
}

// Multipart Mixed Part
export interface MultipartPart {
  id: string;
  contentType: string;
  content: string;
  headers?: Record<string, string>;
}
