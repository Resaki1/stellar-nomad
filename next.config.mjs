import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  sassOptions: {
    // Modern Sass API name (Sass >=1.33). Next 16 / Turbopack may or
    // may not honor this — components should use relative paths to
    // '../../../styles' to remain portable.
    loadPaths: [path.join(__dirname, "src")],
    includePaths: [path.join(__dirname, "src")],
  },
};

export default nextConfig;
