import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  base: "./", // relative assets so it works under a Pages subpath
  plugins: [preact()],
  server: {
    proxy: {
      "/api": "http://localhost:8787",
      "/config.json": "http://localhost:8787",
    },
  },
});
