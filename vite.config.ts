import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 5173, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  build: { target: 'es2022' },
  // Some exhaustive mesh tests take seconds and time out at the default 5 s when the whole suite runs in parallel.
  // Agent worktrees live under .claude/worktrees; their copies of the tests must not run here.
  test: { testTimeout: 30_000, exclude: [...configDefaults.exclude, '.claude/**'] },
});
