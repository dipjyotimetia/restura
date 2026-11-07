import { ProtocolCodeDialog } from '@/components/shared/ProtocolCodeDialog';
import { graphqlCodeGenerators } from '@/lib/shared/codeGenerators/graphql';
import type { HttpRequest } from '@/types';

/** Variables as an object for code generation; invalid JSON → `{}`. */
function parseVariablesOrEmpty(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** "Code" for a GraphQL operation: cURL / fetch / requests via graphqlCodeGenerators. */
export function GraphQLCodeDialog({
  open,
  onOpenChange,
  request,
  query,
  variables,
  operationType,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  request: HttpRequest;
  query: string;
  variables: string;
  operationType: 'query' | 'mutation' | 'subscription' | null | undefined;
}) {
  return (
    <ProtocolCodeDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Generate GraphQL code"
      description="Uses the Headers tab entries as typed: {{variables}} stay unresolved and Auth-tab credentials are not included."
      generators={graphqlCodeGenerators}
      options={{
        url: request.url,
        query,
        variables: parseVariablesOrEmpty(variables),
        headers: Object.fromEntries(
          request.headers.filter((h) => h.enabled && h.key).map((h) => [h.key, h.value])
        ),
        ...(operationType ? { operationType } : {}),
      }}
    />
  );
}
