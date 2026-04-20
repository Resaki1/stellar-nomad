const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  sassOptions: {
    // Modern Sass API name (Sass >=1.33). Next 16 / Turbopack may or
    // may not honor this — components should use relative paths to
    // '../../../styles' to remain portable.
    loadPaths: [path.join(__dirname, 'src')],
    includePaths: [path.join(__dirname, 'src')],
  },
};

module.exports = nextConfig;
