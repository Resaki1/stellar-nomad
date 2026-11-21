// A one-shot WebGPU compatibility check. Serve only the candidate and its pinned three.js modules.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function checkWebGPU(candidate, out) {
  const three = path.resolve(path.dirname(fileURLToPath(import.meta.resolve("three"))), "..");
  const files = new Map([
    ["/", [fileURLToPath(new URL("webgpu.html", import.meta.url)), "text/html"]],
    ["/candidate.glb", [candidate, "model/gltf-binary"]],
  ]);
  for (const name of ["build/three.webgpu.js", "build/three.core.js", "examples/jsm/loaders/GLTFLoader.js",
    "examples/jsm/utils/BufferGeometryUtils.js", "examples/jsm/utils/SkeletonUtils.js"]) {
    files.set("/" + name, [path.join(three, name), "text/javascript"]);
  }

  let finish;
  const report = new Promise((resolve) => { finish = resolve; });
  const server = createServer(async (req, res) => {
    if (req.url === "/result" && req.method === "POST" && req.headers.origin === origin) {
      try {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 4096) throw new Error("Unexpected result size");
        }
        const result = JSON.parse(body);
        res.end("ok");
        finish(result);
      } catch {
        res.writeHead(400).end();
      }
      return;
    }
    const file = files.get(req.url);
    if (!file || req.method !== "GET" || req.headers.host !== new URL(origin).host) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("Content-Type", file[1]);
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    createReadStream(file[0]).on("error", () => res.destroy()).pipe(res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = "http://127.0.0.1:" + server.address().port;
  const profile = mkdtempSync(path.join(tmpdir(), "stellar-model-chrome-"));
  const binary = process.env.CHROME_BIN || (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
  const chrome = spawn(binary, ["--headless=new", "--enable-unsafe-webgpu", "--no-first-run",
    "--no-default-browser-check", ...(process.platform === "darwin" ? ["--use-angle=metal"] : []),
    "--user-data-dir=" + profile, origin], { stdio: "ignore" });
  const closed = new Promise((resolve) => chrome.once("close", resolve));
  chrome.once("error", (error) => finish({ error: error.message }));
  closed.then(() => finish({ error: "Chrome exited before the WebGPU check completed" }));
  const timeout = setTimeout(() => finish({ error: "WebGPU check timed out" }), 60000);
  try {
    const result = await report;
    writeFileSync(path.join(out, "webgpu.json"), JSON.stringify(result, null, 2) + "\n");
    if (result.error || !result.coveredPixels) throw new Error(result.error || "Empty WebGPU report");
    console.log(JSON.stringify(result));
  } finally {
    clearTimeout(timeout);
    chrome.kill();
    server.closeAllConnections();
    server.close();
    const force = setTimeout(() => chrome.kill("SIGKILL"), 3000);
    await closed;
    clearTimeout(force);
    rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
  }
}
