import { defineConfig, searchForWorkspaceRoot } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@game/shared': resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  server: {
    fs: {
      // Setting server.fs.allow REPLACES Vite's default (the workspace root),
      // so keep it and add the repo-root features/ directory on top, which is
      // where the client's import.meta.glob discovers feature client.tsx files.
      allow: [searchForWorkspaceRoot(__dirname), '../../features'],
    },
  },
});
