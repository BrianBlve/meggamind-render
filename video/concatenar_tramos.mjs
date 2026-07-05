// video/concatenar_tramos.mjs — une los tramos parciales en el MP4 4K final (job concat de Actions).
// Baja render/tramos/seg_*.mp4 de R2 -> ffmpeg concat -> sube render/VLOG_CHINA_FINAL_4K.mp4 a R2.
// Clave: el VIDEO se copia sin recodificar (-c:v copy → 4K intacto, rápido); solo el AUDIO se
// re-codifica (-c:a aac), lo que elimina los micro-cortes de priming en las uniones de tramos.
// Env: R2_* (cuenta/llaves/bucket), OUT_KEY (render/VLOG_CHINA_FINAL_4K.mp4).
import {
  S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand,
  CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, stat, open as abrir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";

const E = process.env;
const OUT_KEY = E.OUT_KEY ?? "render/VLOG_CHINA_FINAL_4K.mp4";
const PREFIJO_TRAMOS = "render/tramos/";

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
  return keys.sort(); // seg_00, seg_01, ... en orden
}
async function descargar(key, destino) {
  await mkdir(path.dirname(destino), { recursive: true });
  const r = await s3.send(new GetObjectCommand({ Bucket: E.R2_BUCKET, Key: key }));
  await pipeline(r.Body, createWriteStream(destino));
}


// Subida multipart por partes de 64 MB con reintentos (PutObject simple revienta a los 2 GiB).
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
          console.log(`  parte ${num}: reintento ${att + 1} (${e.message})`);
          await new Promise((res) => setTimeout(res, 3000 * (att + 1)));
        }
      }
      partes.push({ ETag: etag, PartNumber: num });
      if (num % 20 === 0) console.log(`  ${((i + len) / tam * 100).toFixed(0)}% subido`);
    }
    await s3.send(new CompleteMultipartUploadCommand({ Bucket: E.R2_BUCKET, Key: key, UploadId, MultipartUpload: { Parts: partes } }));
  } catch (e) {
    await s3.send(new AbortMultipartUploadCommand({ Bucket: E.R2_BUCKET, Key: key, UploadId })).catch(() => {});
    throw e;
  } finally { await fh.close(); }
}

// Cuenta frames de video reales de un mp4 (para declarar duration exacta y evitar drift en el concat).
async function framesDe(archivo) {
  return await new Promise((resolve, reject) => {
    const p = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0",
      "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", archivo]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (c) => {
      const n = parseInt(out.trim(), 10);
      if (c === 0 && Number.isFinite(n) && n > 0) resolve(n);
      else reject(new Error(`ffprobe frames falló (${c}) en ${path.basename(archivo)}: '${out.trim()}'`));
    });
    p.on("error", reject);
  });
}

async function main() {
  const dir = path.resolve("out", "tramos");
  await mkdir(dir, { recursive: true });
  const keys = await listarTramos();
  if (!keys.length) throw new Error(`No hay tramos en R2 bajo ${PREFIJO_TRAMOS}`);
  console.log(`[concat] ${keys.length} tramos a unir:`);

  const locales = [];
  for (const k of keys) {
    const dst = path.join(dir, path.basename(k));
    console.log(`  R2 -> ${path.basename(k)}`);
    await descargar(k, dst);
    locales.push(dst);
  }

  // RECETA PROBADA (evita drift +60ms/unión): duration EXPLÍCITA por tramo (contando frames reales)
  // + concat mapeando SOLO video (-c:v copy) + muxear audio_full FRESCO aparte (nunca el audio de los tramos).
  const lineas = [];
  for (const dst of locales) {
    const nf = await framesDe(dst);
    lineas.push(`file '${dst.replace(/'/g, "'\\''")}'`);
    lineas.push(`duration ${(nf / 60).toFixed(6)}`);
  }
  const lista = path.join(dir, "lista.txt");
  await writeFile(lista, lineas.join("\n") + "\n");

  // audio_full fresco desde R2 (pista única desde el frame 0)
  const audio = path.join(dir, "audio_full.m4a");
  console.log(`[concat] R2 -> audio_full.m4a`);
  await descargar("china/audio_full.m4a", audio);

  const out = path.resolve("out", "VLOG_CHINA_FINAL_4K.mp4");
  console.log(`[concat] ffmpeg: video copy (4K intacto) + audio_full muxeado aparte -> ${path.basename(out)}`);
  await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", lista, "-i", audio,
    "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", out]);

  const tam = (await stat(out)).size;
  console.log(`[concat] subiendo ${(tam / 1e6).toFixed(0)} MB -> ${OUT_KEY} (multipart)`);
  // PutObject simple tiene límite de 2 GiB: el master 4K (~8 GB) se sube por multipart (64 MB por parte).
  await subirMultipart(out, OUT_KEY, tam);

  if (E.BORRAR_TRAMOS !== "1") {
    console.log(`[concat] tramos CONSERVADOS (default; BORRAR_TRAMOS=1 para borrar). ✅ MP4 4K final en R2: ${OUT_KEY}`);
  } else {
    // Borrar los tramos parciales: ya no sirven y liberan espacio (regla de los 10 GB de R2).
    await s3.send(new DeleteObjectsCommand({ Bucket: E.R2_BUCKET, Delete: { Objects: keys.map((k) => ({ Key: k })) } }));
    console.log(`[concat] tramos borrados (${keys.length}). ✅ MP4 4K final en R2: ${OUT_KEY}`);
  }
}

main().catch((e) => { console.error("concat FALLÓ:", e.message); process.exit(1); });
