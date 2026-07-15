// video/concatenar_reel.mjs — une los tramos del REEL en el MP4 4K final (job concat).
// RECETA PROBADA del vlog (evita drift +60ms/unión): duration EXPLÍCITA por tramo (frames
// reales) + concat mapeando SOLO video (-c:v copy) + muxear audio_final FRESCO aparte.
// Baja reel/tramos/seg_*.mp4 -> concat -> sube reel/out/REEL_FINAL_4K.mp4.
import {
  S3Client, GetObjectCommand, ListObjectsV2Command,
  CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, stat, open as abrir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";

const E = process.env;
const OUT_KEY = E.OUT_KEY ?? "reel/out/REEL_FINAL_4K.mp4";
const PREFIJO_TRAMOS = "reel/tramos/";

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${E.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: E.R2_ACCESS_KEY_ID, secretAccessKey: E.R2_SECRET_ACCESS_KEY },
});

function run(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("error", rej);
    p.on("close", (c) => (c === 0 ? res() : rej(new Error(`${cmd} salió con código ${c}`))));
  });
}

async function listarTramos() {
  const keys = [];
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: E.R2_BUCKET, Prefix: PREFIJO_TRAMOS, ContinuationToken: token }));
    for (const o of r.Contents ?? []) if (o.Key.endsWith(".mp4")) keys.push(o.Key);
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return keys.sort();
}
async function descargar(key, destino) {
  await mkdir(path.dirname(destino), { recursive: true });
  const r = await s3.send(new GetObjectCommand({ Bucket: E.R2_BUCKET, Key: key }));
  await pipeline(r.Body, createWriteStream(destino));
}

async function subirMultipart(archivo, key, tam) {
  const PARTE = 64 * 1024 * 1024;
  const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: E.R2_BUCKET, Key: key }));
  const fh = await abrir(archivo, "r");
  const partes = [];
  try {
    for (let i = 0, num = 1; i < tam; i += PARTE, num++) {
      const len = Math.min(PARTE, tam - i);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, i);
      let etag;
      for (let att = 0; ; att++) {
        try {
          const r = await s3.send(new UploadPartCommand({ Bucket: E.R2_BUCKET, Key: key, UploadId, PartNumber: num, Body: buf }));
          etag = r.ETag; break;
        } catch (e) {
          if (att >= 5) throw e;
          await new Promise((res) => setTimeout(res, 3000 * (att + 1)));
        }
      }
      partes.push({ ETag: etag, PartNumber: num });
    }
    await s3.send(new CompleteMultipartUploadCommand({ Bucket: E.R2_BUCKET, Key: key, UploadId, MultipartUpload: { Parts: partes } }));
  } catch (e) {
    await s3.send(new AbortMultipartUploadCommand({ Bucket: E.R2_BUCKET, Key: key, UploadId })).catch(() => {});
    throw e;
  } finally { await fh.close(); }
}

async function framesDe(archivo) {
  return await new Promise((resolve, reject) => {
    const p = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0",
      "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", archivo]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (c) => {
      const n = parseInt(out.trim(), 10);
      if (c === 0 && Number.isFinite(n) && n > 0) resolve(n);
      else reject(new Error(`ffprobe frames falló (${c}) en ${path.basename(archivo)}`));
    });
    p.on("error", reject);
  });
}

async function main() {
  const plan = JSON.parse(await readFile("public/reel_plan.json", "utf8"));
  const dir = path.resolve("out", "tramos");
  await mkdir(dir, { recursive: true });
  const keys = await listarTramos();
  if (!keys.length) throw new Error(`No hay tramos en R2 bajo ${PREFIJO_TRAMOS}`);
  console.log(`[concat] ${keys.length} tramos a unir`);

  const locales = [];
  for (const k of keys) {
    const dst = path.join(dir, path.basename(k));
    await descargar(k, dst);
    locales.push(dst);
  }

  const lineas = [];
  let totalFrames = 0;
  for (const dst of locales) {
    const nf = await framesDe(dst);
    totalFrames += nf;
    lineas.push(`file '${dst.replace(/'/g, "'\\''")}'`);
    lineas.push(`duration ${(nf / 60).toFixed(6)}`);
  }
  if (totalFrames !== plan.frames)
    throw new Error(`frames totales ${totalFrames} != plan.frames ${plan.frames} — falta o sobra un tramo`);
  console.log(`[concat] ${totalFrames} frames == plan.frames ✓`);
  const lista = path.join(dir, "lista.txt");
  await writeFile(lista, lineas.join("\n") + "\n");

  const audio = path.join(dir, "audio_final.m4a");
  await descargar("reel/audio_final.m4a", audio);

  const out = path.resolve("out", "REEL_FINAL_4K.mp4");
  await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", lista, "-i", audio,
    "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", out]);

  const tam = (await stat(out)).size;
  console.log(`[concat] subiendo ${(tam / 1e6).toFixed(0)} MB -> ${OUT_KEY}`);
  await subirMultipart(out, OUT_KEY, tam);
  console.log(`[concat] LISTO ✓ ${OUT_KEY}`);
}

main().catch((e) => { console.error("concat FALLÓ:", e.message); process.exit(1); });
