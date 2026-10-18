/// <reference types="vite/client" />
import type { PanoCutApi } from '@shared/ipc';

declare global {
  interface Window {
    panocut: PanoCutApi;
  }
}

export {};
