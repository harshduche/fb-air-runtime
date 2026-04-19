import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Base must match the FastAPI mount prefix so that the hashed asset URLs
// emitted by Vite (e.g. /flybuild/assets/index-abc.js) resolve correctly
// through the router mount in flyt_builder/routes.py.
export default defineConfig({
  plugins: [react()],
  base: "/flybuild/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The Python backend injects window.__FLYBUILD__ via index.html.
    // Avoid inlining JS/CSS so the backend can serve them via StaticFiles.
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    proxy: {
      "/workflows": "http://localhost:9001",
      "/infer": "http://localhost:9001",
      "/flybuild/api": "http://localhost:9001",
      "/sam3": "http://localhost:9001",
    },
  },
});
