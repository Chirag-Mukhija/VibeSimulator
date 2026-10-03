import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the static build works from any folder or subpath.
  base: "./",
  server: { port: 5199 },
  preview: { port: 5199 },
});
