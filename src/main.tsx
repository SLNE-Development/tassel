import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initPreferences } from './app/preferences';
import { execute, services, useApp } from './app/store';
import { createBaker } from './bake';
import { createFontService } from './bridge/fonts';
import { startMcpBridge } from './bridge/mcp';
import { initModifiers } from './core/modifiers/evaluate';
import { syncDocumentLanguage } from './i18n';
import { imaging } from './imaging';
import { createExporter, createImporter } from './io';
import { initMinecraftAssets } from './mcassets';
import { createRenderer } from './render';
import { createVideoService } from './video';
import { App } from './ui/App';
import { installCloseGuard } from './ui/closeGuard';
import { notifyError } from './ui/toast';
import './index.css';

initPreferences();
syncDocumentLanguage();
services.exporter = createExporter();
services.importer = createImporter();
services.imaging = imaging;
services.baker = createBaker();
services.renderer = createRenderer();
services.video = createVideoService();
services.fonts = createFontService();
initMinecraftAssets();
startMcpBridge().catch(notifyError);
installCloseGuard();
// Boolean modifiers need their WASM kernel; everything else works without waiting for it.
// Once it is loaded, notify the store's subscribers so the viewport re-evaluates objects with booleans.
initModifiers().then(() => useApp.setState((app) => ({ ...app })), notifyError);

if (import.meta.env.DEV) {
  (window as unknown as { __tessel: unknown }).__tessel = { execute, useApp, services };
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
