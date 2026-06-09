import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';

/**
 * Renders GitHub release notes. electron-updater delivers the notes as HTML
 * (the rendered release body), so they must pass through `rehype-raw` to parse
 * the embedded markup into real elements — without it react-markdown shows the
 * tags as literal text. `rehype-sanitize` runs after (order matters) to strip
 * anything dangerous before it reaches the Electron renderer. The pipeline also
 * handles the markdown/HTML-mixed form (`fullChangelog` array notes).
 */
export function ReleaseNotes({ html }: { html: string }) {
  return (
    <div className="text-sp-12 text-sp-muted break-words [&_a]:text-sp-accent [&_a]:underline [&_code]:font-mono [&_h1]:text-sp-13 [&_h1]:font-semibold [&_h1]:text-sp-text [&_h1]:mb-1 [&_h1]:mt-3 [&_h2]:text-sp-13 [&_h2]:font-semibold [&_h2]:text-sp-text [&_h2]:mb-1 [&_h2]:mt-3 [&_h3]:font-semibold [&_h3]:text-sp-text [&_li]:my-0.5 [&_p]:my-1.5 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 first:[&>*]:mt-0">
      <ReactMarkdown
        rehypePlugins={[rehypeRaw, rehypeSanitize]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {html}
      </ReactMarkdown>
    </div>
  );
}
