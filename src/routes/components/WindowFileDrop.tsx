import { FileDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

const hasFiles = (event: DragEvent) =>
  Array.from(event.dataTransfer?.types ?? []).includes('Files');

/**
 * Drop a collection / environment / spec file anywhere on the window to
 * import it. Only file drags count, and any drop an inner target already
 * handled (form-data files, the import dialog's own zone) is left alone — the
 * listeners run in the bubble phase after React's handlers. Also stops the
 * browser / Electron window from navigating to a dropped file.
 */
export function WindowFileDrop({ onFile }: { onFile: (file: File) => void }) {
  const [active, setActive] = useState(false);
  const depth = useRef(0);
  const onFileRef = useRef(onFile);
  onFileRef.current = onFile;

  useEffect(() => {
    const reset = () => {
      depth.current = 0;
      setActive(false);
    };
    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth.current += 1;
      setActive(true);
    };
    const onLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setActive(false);
    };
    const onOver = (event: DragEvent) => {
      // Allow the drop (and keep the window from navigating to the file).
      if (hasFiles(event)) event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      const handled = event.defaultPrevented;
      event.preventDefault();
      reset();
      if (handled) return;
      const file = event.dataTransfer?.files?.[0];
      if (file) onFileRef.current(file);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragend', reset);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', reset);
    };
  }, []);

  if (!active) return null;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center bg-sp-bg/60 backdrop-blur-[1px]"
    >
      <div className="flex items-center gap-2 rounded-sp-panel border border-dashed border-sp-accent bg-sp-surface px-5 py-4 text-sp-13 text-sp-text shadow-lg">
        <FileDown className="h-4 w-4 text-sp-accent" />
        Drop to import a collection, environment, or spec
      </div>
    </div>
  );
}
