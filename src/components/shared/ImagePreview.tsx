import { useState } from 'react';
import { cn, formatBytes } from '@/lib/shared/utils';

interface ImagePreviewProps {
  /** Base64 of the raw image bytes (Response.body when bodyEncoding === 'base64'). */
  base64: string;
  /** Upstream content type, e.g. "image/png". */
  contentType: string;
  /** Decoded byte size for the footer stat. */
  size: number;
}

/**
 * Renders a binary image response from its base64 body. Toggles between
 * fit-to-viewport and 1:1 actual size, and surfaces natural dimensions once
 * the image loads. Only reached when the proxy tagged the body as base64 and
 * the content type is image/* (see ResponseViewer).
 */
export function ImagePreview({ base64, contentType, size }: ImagePreviewProps) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [actualSize, setActualSize] = useState(false);
  const [errored, setErrored] = useState(false);

  const src = `data:${contentType};base64,${base64}`;

  return (
    <div className="h-full flex flex-col">
      <div
        className={cn(
          'flex-1 min-h-0 overflow-auto flex items-center justify-center p-4',
          'bg-[repeating-conic-gradient(var(--sp-line)_0%_25%,transparent_0%_50%)] bg-[length:20px_20px]'
        )}
      >
        {errored ? (
          <p className="text-sp-12 text-sp-dim font-mono">Could not decode image</p>
        ) : (
          <img
            src={src}
            alt="Response preview"
            onLoad={(e) =>
              setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
            }
            onError={() => setErrored(true)}
            className={cn(
              'rounded-sp-chip shadow-lg',
              actualSize ? 'max-w-none' : 'max-w-full max-h-full object-contain'
            )}
          />
        )}
      </div>
      <div className="shrink-0 flex items-center gap-3 px-3 py-1.5 border-t border-sp-line text-sp-10-5 text-sp-dim font-mono">
        <span>{contentType}</span>
        {dims && (
          <span>
            {dims.w} × {dims.h}px
          </span>
        )}
        <span>{formatBytes(size)}</span>
        <div className="flex-1" />
        {dims && (
          <button
            type="button"
            onClick={() => setActualSize((v) => !v)}
            className="px-2 py-0.5 rounded-sp-chip hover:bg-sp-hover hover:text-sp-text transition-colors"
          >
            {actualSize ? 'Fit' : 'Actual size'}
          </button>
        )}
      </div>
    </div>
  );
}

export default ImagePreview;
