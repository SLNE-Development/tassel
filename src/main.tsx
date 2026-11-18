import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { execute, services, useApp } from './app/store';
import { startMcpBridge } from './bridge/mcp';
import { initModifiers } from './core/modifiers/evaluate';
import { gltfExporter } from './io/gltf';
import { App } from './ui/App';
import { installCloseGuard } from './ui/closeGuard';
import { notifyError } from './ui/toast';
import './index.css';

services.exporter = gltfExporter;
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
