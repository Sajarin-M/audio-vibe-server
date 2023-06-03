import axiod from "https://deno.land/x/axiod@0.26.2/mod.ts";
import { oakCors } from "https://deno.land/x/cors@v1.2.2/mod.ts";
import { Application, Router } from "https://deno.land/x/oak@v12.3.0/mod.ts";
import hash from "https://deno.land/x/object_hash@2.0.3.1/mod.ts";
import { z, ZodError } from "npm:zod@3.21.4";
import { ensureDir, exists, walk } from "std/fs/mod.ts";
import { dirname, fromFileUrl, join } from "std/path/mod.ts";
import { exec } from "./lib/exec.ts";
import config from "./config.ts";

const dataDir = join(dirname(fromFileUrl(import.meta.url)), "..", "data");
const songsDir = join(dataDir, "songs");
const donwloadDir = join(dataDir, "download");
const cacheDir = join(dataDir, "cache");
const cacheFilePath = join(cacheDir, "requests");

await ensureDir(dataDir);
await ensureDir(cacheDir);
await ensureDir(songsDir);

const kv = await Deno.openKv(cacheFilePath);

const app = new Application();
app.use(oakCors());

const router = new Router();

const cacheRequestSchema = z.object({
  method: z.enum(["GET", "POST"]),
  url: z.string().url(),
});
router.post("/cache-request", async (ctx) => {
  const data = await ctx.request.body({
    type: "json",
  }).value;

  await cacheRequestSchema.safeParseAsync(data);
  const requestHash = hash(data);
  const cachedResponse = await kv.get([requestHash]);

  if (cachedResponse.value) {
    console.log(`✅ Cache hit : ${data.url}`);
    ctx.response.body = cachedResponse.value;
    return;
  }

  console.log(`⚠︰ Cache miss : ${data.url}`);
  const { data: newResponse } = await axiod.request({
    ...data,
    headers: {
      "X-RapidAPI-Key": config.RAPIDAPI_KEY,
      "X-RapidAPI-Host": config.RAPIDAPI_HOST,
    },
  });
  await kv.set([requestHash], newResponse);
  ctx.response.body = newResponse;
});

router.get("/songs/:id", async (ctx) => {
  const songName = ctx.params.id;
  const range = ctx.request.headers.get("range");
  const songPath = join(songsDir, songName);
  if (await exists(songPath)) {
    const songSize = (await Deno.stat(songPath)).size;

    if (!range) {
      ctx.response.headers.set("Content-Length", songSize.toString());
      ctx.response.headers.set("Content-Type", "audio/mpeg");
      ctx.response.body = await Deno.readFile(songPath);
      return;
    } else {
      const [first, second] = range.replace(/bytes=/, "").split("-");
      const start = parseInt(first, 10);
      let end = second ? parseInt(second, 10) : songSize - 1;
      const maxChunk = 1024 * 1024;

      if (end - start + 1 > maxChunk) {
        end = start + maxChunk - 1;
      }

      ctx.response.headers.set(
        "Content-Range",
        `bytes ${start}-${end}/${songSize}`
      );
      ctx.response.headers.set("Accept-Ranges", "bytes");
      ctx.response.headers.set("Content-Length", (end - start + 1).toString());

      let seek;
      if (start === 0) {
        seek = Deno.SeekMode.Start;
      } else if (end === songSize - 1) {
        seek = Deno.SeekMode.End;
      } else {
        seek = Deno.SeekMode.Current;
      }

      const file = await Deno.open(songPath, {
        read: true,
      });
      await Deno.seek(file.rid, start, seek);
      const content = new Uint8Array(end - start + 1);
      await file.read(content);
      file.close();

      ctx.response.type = "audio/mpeg";
      ctx.response.status = 206;
      ctx.response.body = content;
      return;
    }
  }
  ctx.response.status = 404;
  ctx.response.body = "Song not found";
});

async function clearDownloadsFolder() {
  try {
    for await (const entry of walk(donwloadDir)) {
      await Deno.remove(entry.path, { recursive: true });
    }
  } catch (_) {
    /*  Ignore */
  }
}

router.post("/music-url", async (ctx) => {
  const { url } = await ctx.request.body({
    type: "json",
  }).value;
  const songFilename = `${hash(url)}.mp3`;
  const songPath = join(songsDir, songFilename);

  if (await exists(songPath)) {
    console.log(`✅ Song already downloaded : ${url}`);
    return (ctx.response.body = songFilename);
  }

  console.log(`⚠︰ Song downloading : ${url}`);
  const result = await exec(`spotifydl --o ${donwloadDir} ${url}`);

  if (result.status.code === 0) {
    let filePath: string | undefined;
    if (await exists(donwloadDir)) {
      for await (const entry of walk(donwloadDir)) {
        if (entry.isFile && entry.name.endsWith(".mp3")) {
          filePath = entry.path;
          break;
        }
      }
    }
    if (filePath) {
      await Deno.rename(filePath, join(songsDir, songFilename));
      ctx.response.body = songFilename;
      console.log(`✅ Song downloaded : ${url}`);
    }
    return await clearDownloadsFolder();
  } else {
    ctx.response.status = 500;
    ctx.response.body = "Failed to download song";
    await clearDownloadsFolder();
  }
  console.log(`⚠︰ Song download failed : ${url}`);
});

app.use(router.routes());
app.use(router.allowedMethods());

app.addEventListener("error", async (e) => {
  try {
    await clearDownloadsFolder();
    if (e.error instanceof ZodError) {
      console.log("⚠︰ Validation error :", e.error.issues[0].message);
      if (e.context) {
        e.context.response.status = 400;
        e.context.response.body = e.error.issues;
        return;
      }
    }
    console.log("⚠︰ Unknown error", e.error);
    if (e.context) {
      e.context.response.body = "Internal Server Error";
      e.context.response.status = 500;
    }
  } catch (_) {
    /*  Ignore */
  }
});
app.addEventListener("listen", () => {
  console.log("⚡︰ Server started on port 3000...");
});

await app.listen({ port: 3000 });
