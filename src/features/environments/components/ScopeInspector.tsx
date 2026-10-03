import { useVariableDetails } from '@/hooks/useVariableStatus';
import { variableSourceLabel } from '@/lib/shared/variableScopes';
import { useRequestStore } from '@/store/useRequestStore';

/**
 * Every `{{name}}` the active request tab can use, with the value that wins
 * and the scope it comes from — the same precedence the send path applies
 * (nearest folder > outer folders > collection > sub-environment >
 * environment > globals), so this never disagrees with what is sent.
 */
export function ScopeInspector() {
  const tab = useRequestStore((s) => s.getActiveTab());
  // HTTP sends resolve every scope; the connection protocols (and GraphQL)
  // resolve only the active environment and globals — show what this tab uses.
  const connection = tab ? (tab.modeOverride ?? tab.request.type) !== 'http' : false;
  const details = useVariableDetails(connection ? 'connection' : 'request');
  const tabName = tab?.request.name;
  const rows = [...details].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="flex-1 overflow-y-auto px-5 py-4">
      <div className="sp-label mb-1">Variables in scope</div>
      <p className="mb-3 text-sp-12 text-sp-muted">
        {tabName ? (
          <>
            What <span className="text-sp-text">{tabName}</span> resolves each{' '}
            <code className="font-mono">{'{{name}}'}</code> to, and where the winning value comes
            from.
          </>
        ) : (
          'Open a request to see what its variables resolve to.'
        )}
        {connection && ' This protocol resolves only the active environment and globals.'}
      </p>
      {rows.length === 0 ? (
        <p className="py-6 text-center font-mono text-sp-12 text-sp-dim">No variables in scope</p>
      ) : (
        <table className="w-full table-fixed border-collapse font-mono text-sp-12">
          <thead>
            <tr className="border-b border-sp-line text-left text-sp-11 uppercase tracking-wider text-sp-dim">
              <th scope="col" className="w-1/3 py-1.5 pr-2 font-medium">
                Name
              </th>
              <th scope="col" className="py-1.5 pr-2 font-medium">
                Value
              </th>
              <th scope="col" className="w-36 py-1.5 font-medium">
                Scope
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name} className="border-b border-sp-line/50">
                <td className="truncate py-1.5 pr-2 text-sp-text">{row.name}</td>
                <td className="truncate py-1.5 pr-2 text-sp-muted">
                  {row.secret ? (
                    <span aria-label="secret value">••••••</span>
                  ) : row.value === undefined ? (
                    <span className="italic text-sp-dim">set by a script at run time</span>
                  ) : (
                    row.value
                  )}
                </td>
                <td className="py-1.5 text-sp-muted">{variableSourceLabel(row.source)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
