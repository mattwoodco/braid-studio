import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, resolve as resolvePath } from "node:path";
import { Readable } from "node:stream";

type RouteCtx = { params: Promise<{ filename: string }> };

const FINALS_DIR = resolvePath(process.cwd(), "data", "finals");
const SAFE_NAME = /^[A-Za-z0-9._-]+\.mp4$/;

function toWebStream(filePath: string): ReadableStream<Uint8Array> {
  return Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream<Uint8Array>;
}

export async function GET(req: Request, ctx: RouteCtx): Promise<Response> {
  const { filename } = await ctx.params;
  const name = basename(filename);
  if (!SAFE_NAME.test(name)) {
    return new Response("bad name", { status: 400 });
  }
  const full = resolvePath(FINALS_DIR, name);
  if (!full.startsWith(`${FINALS_DIR}/`)) {
    return new Response("forbidden", { status: 403 });
  }

  let size: number;
  try {
    const s = await stat(full);
    if (!s.isFile()) return new Response("not found", { status: 404 });
    size = s.size;
  } catch {
    return new Response("not found", { status: 404 });
  }

  const range = req.headers.get("range");
  if (range) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : size - 1;
      if (start <= end && end < size) {
        const stream = Readable.toWeb(
          createReadStream(full, { start, end }),
        ) as unknown as ReadableStream<Uint8Array>;
        return new Response(stream, {
          status: 206,
          headers: {
            "Content-Type": "video/mp4",
            "Content-Length": String(end - start + 1),
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-store",
          },
        });
      }
    }
  }

  return new Response(toWebStream(full), {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    },
  });
}
