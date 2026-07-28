// Monaco ships type declarations only from the package root (`monaco-editor`).
// To keep the bundle lean we import the trimmed ESM API entry plus a handful of
// side-effect language contributions (see `src/lib/shared/monaco-setup.ts`)
// instead of the full `monaco-editor` barrel. monaco-editor's `exports` map
// exposes those deep subpaths via `./*` with no `types` condition, so TS's
// bundler resolution can't find their `.d.ts` even though Vite resolves them at
// runtime. Map the API entry to the root types and declare the side-effect
// modules as untyped (they only register languages/features for their effect).
//
// The root tsconfig globs `**/*.ts` and picks this up automatically. The
// per-feature `src/features/http/tsconfig.json` globs only its own dir, so it
// adds `../../types/**/*.d.ts` to its `include` to see this file.

declare module 'monaco-editor/editor' {
  export * from 'monaco-editor';
}
declare module 'monaco-editor/features/register.all';
declare module 'monaco-editor/languages/features/json/register';
declare module 'monaco-editor/languages/features/typescript/register';
declare module 'monaco-editor/languages/definitions/javascript/register';
declare module 'monaco-editor/languages/features/html/register';
declare module 'monaco-editor/languages/features/css/register';
declare module 'monaco-editor/languages/definitions/xml/register';
