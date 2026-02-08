import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: {
    port: 8790,
    strictPort: true,
  },
});
