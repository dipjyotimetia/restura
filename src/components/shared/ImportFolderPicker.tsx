import { FolderOpen } from 'lucide-react';
import { type ChangeEvent, useRef } from 'react';

interface ImportFolderPickerProps {
  onFolderPicked: (event: ChangeEvent<HTMLInputElement>) => void;
}

/**
 * "Import folder" for Postman v3 collection folders (#1200).
 * `webkitdirectory` works in browsers and Electron's renderer alike, so no
 * IPC is involved; the picked Files are read by the shared folder walk.
 */
export function ImportFolderPicker({ onFolderPicked }: ImportFolderPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="mt-2 flex items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        aria-label="Postman v3 collection folder"
        data-testid="postman-folder-input"
        onChange={onFolderPicked}
        {...({ webkitdirectory: '' } as Record<string, string>)}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-sp-btn bg-sp-surface border border-sp-line text-sp-text text-sp-12 font-medium hover:bg-sp-hover transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent"
      >
        <FolderOpen size={12} aria-hidden="true" />
        Import folder
      </button>
      <span className="text-sp-12 text-sp-muted">
        Postman v3 collection folder (or drop a v3 .zip above)
      </span>
    </div>
  );
}
