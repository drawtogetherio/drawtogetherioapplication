/// <reference types="vite/client" />

/** The web app's version, from package.json at build time. */
declare const __APP_VERSION__: string;
/** Canvas logs are compiled in: beta builds and the dev server only, never the live site. */
declare const __CANVAS_LOG__: boolean;
