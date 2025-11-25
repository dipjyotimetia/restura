/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_VERSION: string;
  readonly VITE_IS_ELECTRON_BUILD: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
