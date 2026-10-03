import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Renders user-authored markdown (collection docs). react-markdown escapes raw
 * HTML by default — no `rehype-raw`, no innerHTML — so docs can't inject markup.
 */
export default function MarkdownPreview({ source }: { source: string }) {
  if (!source.trim()) {
    return <p className="text-sp-12 italic text-sp-dim">Nothing to preview yet.</p>;
  }
  return (
    <div className="space-y-2 text-sp-12-5 leading-relaxed text-sp-text [&_code]:rounded-sp-chip [&_code]:bg-sp-surface-lo [&_code]:px-1 [&_code]:font-mono [&_h1]:text-sp-16 [&_h1]:font-semibold [&_h2]:text-sp-14 [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-4 [&_ol]:list-decimal [&_pre]:overflow-auto [&_pre]:rounded-sp-btn [&_pre]:bg-sp-surface-lo [&_pre]:p-2 [&_table]:text-sp-12 [&_td]:border [&_td]:border-sp-line [&_td]:px-2 [&_th]:border [&_th]:border-sp-line [&_th]:px-2 [&_ul]:list-disc">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sp-accent underline underline-offset-2"
            >
              {children}
            </a>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
