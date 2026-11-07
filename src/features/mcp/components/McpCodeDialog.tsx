import { ProtocolCodeDialog } from '@/components/shared/ProtocolCodeDialog';
import { mcpCodeGenerators } from '@/lib/shared/codeGenerators/mcp';
import type { McpRequest } from '@/types';

/** "Code" for an MCP server connection: raw JSON-RPC cURL or the TypeScript SDK. */
export function McpCodeDialog({
  open,
  onOpenChange,
  request,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  request: McpRequest;
}) {
  return (
    <ProtocolCodeDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Generate MCP client code"
      description="Uses the Headers entries as typed: {{variables}} stay unresolved and Auth-tab credentials are not included."
      generators={mcpCodeGenerators}
      options={{ request }}
    />
  );
}
