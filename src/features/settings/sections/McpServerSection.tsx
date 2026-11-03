import { McpServerSettings } from '@/features/mcp-server/components/McpServerSettings';
import { FieldGroup, FieldRow, SectionHeader } from '../components/SettingsSectionPrimitives';

/** Settings → MCP Server: the agent control server (ADR 0041). */
export function McpServerSection() {
  return <McpServerSettings Header={SectionHeader} Group={FieldGroup} Row={FieldRow} />;
}
