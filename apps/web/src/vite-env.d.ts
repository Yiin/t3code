/// <reference types="vite-plus/client" />

import type { DesktopBridge, LocalApi } from "@t3tools/contracts";

declare global {
  // Vite only substitutes variables that are actually set at build time, so
  // every entry here is optional at runtime.
  interface ImportMetaEnv {
    readonly VITE_HTTP_URL?: string;
    readonly VITE_WS_URL?: string;
    readonly VITE_DEV_SERVER_URL?: string;
    readonly VITE_HOSTED_APP_URL?: string;
    readonly VITE_HOSTED_APP_CHANNEL?: string;
    readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
    readonly VITE_CLERK_JWT_TEMPLATE?: string;
    readonly VITE_CLERK_CLI_OAUTH_CLIENT_ID?: string;
    readonly VITE_T3CODE_RELAY_URL?: string;
    readonly VITE_RELAY_OTLP_TRACES_URL?: string;
    readonly VITE_RELAY_OTLP_TRACES_DATASET?: string;
    readonly VITE_RELAY_OTLP_TRACES_TOKEN?: string;
    readonly APP_VERSION?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }

  interface Window {
    nativeApi?: LocalApi;
    desktopBridge?: DesktopBridge;
  }
}
