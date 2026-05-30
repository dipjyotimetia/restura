// Monaco ships type declarations only from the package root (`monaco-editor`).
// To keep the bundle lean we import the trimmed ESM API entry plus a handful of
// side-effect language contributions (see `src/lib/shared/monaco-setup.ts`)
// instead of the full `monaco-editor` barrel. Those deep paths have no bundled
// `.d.ts`, so map the API entry to the root types and declare the side-effect
// modules as untyped (they only register languages/features for their effect).

declare module 'monaco-editor/esm/vs/editor/editor.api' {
  export * from 'monaco-editor';
}
declare module 'monaco-editor/esm/vs/editor/editor.all.js';
declare module 'monaco-editor/esm/vs/language/json/monaco.contribution';
declare module 'monaco-editor/esm/vs/language/typescript/monaco.contribution';
declare module 'monaco-editor/esm/vs/language/html/monaco.contribution';
declare module 'monaco-editor/esm/vs/language/css/monaco.contribution';
declare module 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution';
