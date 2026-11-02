import { defineConfig } from 'vite';

// Served from https://<user>.github.io/gcode_merge_web/ on GitHub Pages.
export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/gcode_merge_web/' : '/',
});
