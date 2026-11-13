/**
 * Dev-only sink for `__test.image.save` / `__test.audio.save`: writes the POSTed body
 * to `.captures/<name>` (gitignored) so an agent driving the in-app browser pane can
 * get frames and recordings onto disk. `scripts/drive.mjs` doesn't need it (CDP hands
 * it the bytes directly).
 *
 * ⚠ `pnpm start` binds 0.0.0.0, so anything on the LAN can reach this in dev. Hence:
 * 404 outside development, flat sanitised names, an extension whitelist, a size cap.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED_EXT = new Set([".png", ".webm", ".mp4", ".wav", ".json", ".txt"]);

export async function POST(req: Request): Promise<Response> {
  if (process.env.NODE_ENV !== "development") {
    return new Response("Not found", { status: 404 });
  }
  const raw = new URL(req.url).searchParams.get("name") ?? "";
  // Flatten to one safe path segment: no directories, no dotfiles.
  const name = raw.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "");
  const ext = path.extname(name).toLowerCase();
  if (!name || !ALLOWED_EXT.has(ext)) {
    return Response.json({ error: `bad name "${raw}" (allowed: ${Array.from(ALLOWED_EXT).join(" ")})` }, { status: 400 });
  }
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length === 0 || buf.length > MAX_BYTES) {
    return Response.json({ error: `size ${buf.length} outside 1..${MAX_BYTES}` }, { status: 413 });
  }
  const dir = path.join(process.cwd(), ".captures");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, buf);
  return Response.json({ path: path.relative(process.cwd(), file), bytes: buf.length });
}
