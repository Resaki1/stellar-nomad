import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Build state, stamped into the bundle for `BenchReport.env`.
 *
 * ⚠⚠ THIS EXISTS BECAUSE THE SAME FAILURE HAPPENED TWICE: both the 2026-09-05 and the
 * 2026-09-07 performance baselines were taken on a DIRTY tree with hundreds of
 * uncommitted lines in the very file under test, and neither report recorded it. The
 * doc asked for "note the git SHA" in prose, which is exactly the level of enforcement
 * that failed. A baseline without build state is an anecdote.
 * Best-effort: any failure yields "unknown" rather than breaking the build.
 */
const gitState = (() => {
  try {
    const sha = execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    const dirty =
      execSync("git status --porcelain", {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim().length > 0;
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return "unknown";
  }
})();

// Public signal origins. Credentials for optional TURN are managed solely on the Worker.
const coopPreviews = new Set(["codex/m4-1-host-and-join", "codex/m4-shared-expedition"]);
const signalWorker = process.env.VERCEL_ENV === "production" ? "production"
  : process.env.VERCEL_ENV === "preview" && coopPreviews.has(process.env.VERCEL_GIT_COMMIT_REF) ? "staging" : null;

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_GIT_STATE: gitState,
    ...(signalWorker && !process.env.NEXT_PUBLIC_COOP_SIGNAL_URL && {
      NEXT_PUBLIC_COOP_SIGNAL_URL: `https://stellar-nomad-coop-${signalWorker}.christian-reski.workers.dev`,
    }),
  },
  sassOptions: {
    // Modern Sass API name (Sass >=1.33). Next 16 / Turbopack may or
    // may not honor this — components should use relative paths to
    // '../../../styles' to remain portable.
    loadPaths: [path.join(__dirname, "src")],
    includePaths: [path.join(__dirname, "src")],
  },
};

export default nextConfig;
