/** Permissions are intentionally capability-oriented rather than transport-oriented.
 * Runtime adapters still enforce request/MCP allowlists before a tool reaches this layer. */
export type PermissionClass =
  | 'read'
  | 'network'
  | 'mutation'
  | 'credential'
  | 'filesystem'
  | 'process'
  | 'destructive';

export interface PolicyProfile {
  id: string;
  name: string;
  version: number;
  autoApprove: PermissionClass[];
  ciEligible: boolean;
}

export type ToolPolicyDecision =
  | { decision: 'allowed'; reason: string }
  | { decision: 'approval-required'; reason: string };

/** Evaluate only the approval decision. Platform adapters remain responsible for
 * source allowlists, SSRF, credentials, and execution policy. */
export function evaluateToolPolicy(
  profile: PolicyProfile | undefined,
  permissionClass: PermissionClass
): ToolPolicyDecision {
  if (permissionClass === 'read') {
    return { decision: 'allowed', reason: 'read-only tool' };
  }
  if (profile?.autoApprove.includes(permissionClass)) {
    return {
      decision: 'allowed',
      reason: `policy ${profile.id} auto-approved ${permissionClass} tool`,
    };
  }
  return {
    decision: 'approval-required',
    reason: `explicit approval required for ${permissionClass} tool`,
  };
}

/** CI may never turn a desktop profile into an unattended write capability. */
export function isCiSafePolicy(profile: PolicyProfile): boolean {
  return profile.ciEligible && profile.autoApprove.every((permission) => permission === 'read');
}
