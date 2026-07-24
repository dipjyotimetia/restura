import { Keyboard as KeyboardIcon } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Floater, Kbd } from '@/components/ui/spatial';
import { SectionHeader, SectionLabel } from '../components/SettingsSectionPrimitives';

interface ShortcutGroup {
  title: string;
  shortcuts: Array<{ keys: string[]; description: string }>;
}

export function ShortcutsSection({ groups }: { groups: ShortcutGroup[] }) {
  return (
    <>
      <SectionHeader
        icon={KeyboardIcon}
        title="Shortcuts"
        description="Keyboard bindings available across the app."
      />

      {groups.map((group) => (
        <section key={group.title} className="mt-5 first:mt-0">
          <SectionLabel>{group.title}</SectionLabel>
          <Floater
            radius="panel"
            elevation="inset"
            className="px-4 grid grid-cols-2 gap-x-6 divide-x divide-sp-line"
          >
            {[0, 1].map((col) => (
              <ul
                key={col}
                className="divide-y divide-sp-line"
                style={{ paddingLeft: col === 1 ? '1.5rem' : 0 }}
              >
                {group.shortcuts
                  .filter((_, i) => i % 2 === col)
                  .map((s) => (
                    <li
                      key={s.description}
                      className="flex items-center justify-between gap-3 py-2.5"
                    >
                      <span className="text-sp-12-5 text-sp-text">{s.description}</span>
                      <span className="inline-flex items-center gap-1 shrink-0">
                        {s.keys.map((k, i) => (
                          <Kbd key={i} size="xs">
                            {k}
                          </Kbd>
                        ))}
                      </span>
                    </li>
                  ))}
              </ul>
            ))}
          </Floater>
        </section>
      ))}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  About                                                                      */
/* -------------------------------------------------------------------------- */

export function GithubMark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.09 3.29 9.4 7.86 10.93.58.1.79-.25.79-.56v-2.16c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.68-1.28-1.68-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.3-.51-1.47.11-3.06 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.21-1.49 3.18-1.18 3.18-1.18.62 1.59.23 2.76.11 3.06.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.4-5.25 5.68.41.36.78 1.05.78 2.12v3.14c0 .31.21.67.8.55C20.21 21.4 23.5 17.09 23.5 12 23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/*  Updates                                                                    */
/* -------------------------------------------------------------------------- */

export function formatReleaseDate(isoDate: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(isoDate));
}

export function ReleaseNoteMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children: linkChildren, href }) => (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-sp-accent underline underline-offset-2"
          >
            {linkChildren}
          </a>
        ),
        code: ({ children: codeChildren }) => (
          <code className="rounded bg-sp-hover px-1 py-0.5 font-mono text-sp-11 text-sp-text">
            {codeChildren}
          </code>
        ),
        img: () => null,
        p: ({ children: paragraphChildren }) => <>{paragraphChildren}</>,
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
