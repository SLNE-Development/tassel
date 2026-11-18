import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { execute, services, useApp } from './app/store';
import { startMcpBridge } from './bridge/mcp';
import { gltfExporter } from './io/gltf';
import { App } from './ui/App';
import { installCloseGuard } from './ui/closeGuard';
import { notifyError } from './ui/toast';
import './index.css';

services.exporter = gltfExporter;
startMcpBridge().catch(notifyError);
installCloseGuard();

if (import.meta.env.DEV) {
  (window as unknown as { __tessel: unknown }).__tessel = { execute, useApp, services };
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
