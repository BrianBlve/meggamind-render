// video/render_reel_tramo.mjs — renderiza UN tramo (frameRange) del REEL 4K en un runner.
// Baja los assets de R2 (piezas COLOREADAS reel/crsrc -> public/rsrc, fuentes, audio_final),
// `remotion render Reel --frames=FROM-TO --scale=2` (1080x1920 -> 2160x3840) y sube el parcial.
// Env: R2_*, FROM, TO, IDX, CONCURRENCY (2), OFFTHREAD_CACHE.
import {
  S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";

const E = process.env;
const FROM = Number(E.FROM ?? 0);
const TO = Number(E.TO ?? 0);
const IDX = E.IDX ?? "00";
const CONCURRENCY = E.CONCURRENCY ?? "2";
const OFFTHREAD_CACHE = E.OFFTHREAD_CACHE ?? "268435456";
const OUT_KEY = `reel/tramos/seg_${IDX}.mp4`;

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${E.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: E.R2_ACCESS_KEY_ID, secretAccessKey: E.R2_SECRET_ACCESS_KEY },
});
const PUB = path.resolve("public");

function run(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("error", rej);
    p.on("close", (c) => (c === 0 ? res() : rej(new Error(`${cmd} salió con código ${c}`))));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listarKeys(prefijo) {
  const keys = new Set();
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: E.R2_BUCKET, Prefix: prefijo, ContinuationToken: token }));
    for (const o of r.Contents ?? []) keys.add(o.Key);
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return keys;
}
async function descargar(key, destino, intentos = 3) {
  await mkdir(path.dirname(destino), { recursive: true });
  for (let i = 1; i <= intentos; i++) {
    try {
      const r = await s3.send(new GetObjectCommand({ Bucket: E.R2_BUCKET, Key: key }));
      await pipeline(r.Body, createWriteStream(destino));
      return;
    } catch (e) {
      if (i === intentos) throw e;
      await sleep(2000 * i);
    }
  }
}

// Piezas del plan que el tramo [FROM,TO] usa (por tiempo de pieza y overlays con pip).
function piezasDelTramo(plan) {
  const fps = plan.fps ?? 60;
  const s = new Set();
  const cubre = (at, dur) => {
    const f0 = Math.round(at * fps), f1 = Math.round((at + dur) * fps);
    return f1 >= FROM && f0 <= TO;
  };
  for (const p of plan.piezas) {
    if (!cubre(p.at, p.dur)) continue;
    s.add(p.src);
    if (p.visual?.src) s.add(p.visual.src);
  }
  // los overlays con pip vuelven a dibujar piezas: ya cubiertas por el spine (mismos src)
  return [...s];
}

async function main() {
  const plan = JSON.parse(await readFile(path.join(PUB, "reel_plan.json"), "utf8"));
  if (plan.modo !== "4k") throw new Error(`plan.modo debe ser 4k, es ${plan.modo}`);
  const piezas = piezasDelTramo(plan);
  console.log(`[tramo ${IDX}] frames ${FROM}-${TO} — ${piezas.length} piezas de R2`);

  const enR2 = await listarKeys("reel/");
  const faltan = piezas.filter((v) => !enR2.has(`reel/crsrc/${v}`));
  if (faltan.length) throw new Error(`Faltan coloreadas en R2: ${faltan.join(", ")}`);

  for (const [i, v] of piezas.entries()) {
    const dst = path.join(PUB, "rsrc", v);
    if (existsSync(dst)) continue;
    console.log(`  [${i + 1}/${piezas.length}] R2 crsrc -> rsrc/${v}`);
    await descargar(`reel/crsrc/${v}`, dst);
  }

  // globales: audio_final (desde frame 0), fuentes (hook_alpha COLOREADO, screencasts, fonts)
  await descargar("reel/audio_final.m4a", path.join(PUB, "audio_final.m4a"));
  const FUENTES = [
    "fuentes/hook_alpha_color.webm",
    "fuentes/escena_plataformas.mp4",
    "fuentes/telegram_cfr.mp4",
    "fuentes/juego_cfr.mp4",
    "fuentes/fonts/NewYorkItalic.ttf",
  ];
  for (const f of FUENTES) {
    const local = f === "fuentes/hook_alpha_color.webm" ? "fuentes/hook_alpha.webm" : f;
    await descargar(`reel/${f}`, path.join(PUB, local));
  }

  const out = path.resolve("out", `seg_${IDX}.mp4`);
  await mkdir(path.dirname(out), { recursive: true });
  console.log(`[tramo ${IDX}] remotion render Reel --frames=${FROM}-${TO} --scale=2`);
  await run("npx", ["remotion", "render", "Reel", out,
    `--frames=${FROM}-${TO}`, `--concurrency=${CONCURRENCY}`, "--scale=2",
    "--codec=h264", "--crf=14", "--color-space=bt709",
    "--timeout=300000",
    `--offthreadvideo-cache-size-in-bytes=${OFFTHREAD_CACHE}`]);

  const mb = (await stat(out)).size / 1e6;
  console.log(`[tramo ${IDX}] subiendo ${mb.toFixed(0)} MB -> ${OUT_KEY}`);
  await s3.send(new PutObjectCommand({ Bucket: E.R2_BUCKET, Key: OUT_KEY, Body: await readFile(out) }));
  console.log(`[tramo ${IDX}] LISTO ✓`);
}

main().catch((e) => { console.error(`tramo ${IDX} FALLÓ:`, e.message); process.exit(1); });
