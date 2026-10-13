import { defineConfig } from 'vite';

export default defineConfig({
  // NEXT_PUBLIC_ is kept so the env names from the old Next.js version keep working after the move to Vite
  envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
  esbuild: { jsx: 'automatic' },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
