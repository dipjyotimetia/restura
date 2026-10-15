import { UnappliedAuthNotice } from '@/features/auth/components/editors/UnappliedAuthNotice';
import { useInheritedAuth } from '@/features/auth/components/InheritedAuthHint';
import { buildSubscriptionHandshake } from '@/features/graphql/lib/subscriptionAuth';
import { buildActiveRequestVariableResolution } from '@/lib/shared/activeRequestScopes';
import { isElectron } from '@/lib/shared/platform';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import type { HttpRequest } from '@/types';

/**
 * Auth-tab note for subscription documents: where the credentials go on each
 * harness, plus an {@link UnappliedAuthNotice} for anything configured that
 * the subscription can't send (#882).
 */
export function SubscriptionAuthNotice({ request }: { request: HttpRequest }) {
  const inherited = useInheritedAuth(request);
  const resolveVariables = useEnvironmentStore((s) => s.resolveVariables);
  const desktop = isElectron();
  const { values, secretVariables } = buildActiveRequestVariableResolution();
  const { unapplied } = buildSubscriptionHandshake({
    request,
    ...(inherited ? { inheritedAuth: inherited.auth } : {}),
    values,
    secretVariables,
    resolveVariables,
    desktop,
  });

  return (
    <div className="mb-4 space-y-2" data-testid="subscription-auth-notice">
      <p className="text-sp-11 text-sp-muted font-mono">
        {desktop
          ? 'For subscriptions, header auth is sent as WebSocket handshake headers and in the graphql-ws connection_init payload. Keychain-stored secrets are resolved by the desktop app and sent as handshake headers only.'
          : 'For subscriptions, browsers can’t set WebSocket handshake headers, so header auth is sent in the graphql-ws connection_init payload.'}{' '}
        An API key set to Query Params is added to the socket URL.
      </p>
      {unapplied.map((message) => (
        <UnappliedAuthNotice key={message} message={message} testId="subscription-unapplied-auth" />
      ))}
    </div>
  );
}
