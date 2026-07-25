import { Lock } from 'lucide-react';

export function NoAuthEditor() {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center">
      <div className="mb-2 inline-flex items-center justify-center h-9 w-9 rounded-full bg-sp-surface-lo text-sp-dim">
        <Lock size={16} />
      </div>
      <p className="text-sp-13 text-sp-muted font-medium">No authentication</p>
      <p className="text-sp-11 text-sp-dim mt-1 max-w-[260px]">
        Choose an authentication method to configure credentials for this request.
      </p>
    </div>
  );
}
