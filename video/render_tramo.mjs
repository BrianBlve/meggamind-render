// video/render_tramo.mjs — renderiza UN tramo (frameRange) del Vlog en un runner de GitHub Actions.
// Baja las piezas del plan de R2 -> `remotion render --frames=FROM-TO` -> sube el parcial a R2.
// Env: R2_* (cuenta/llaves/bucket), FROM, TO, IDX, CONCURRENCY (2), OFFTHREAD_CACHE, PREFIJO (china).
import {
  S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";

const E = process.env;
const PREFIJO = E.PREFIJO ?? "china";
const FROM = Number(E.FROM ?? 0);
const TO = Number(E.TO ?? 0);
const IDX = E.IDX ?? "00";
const CONCURRENCY = E.CONCURRENCY ?? "2";
const OFFTHREAD_CACHE = E.OFFTHREAD_CACHE ?? "268435456"; // 256MB; el runner privado tiene 7GB
const OUT_KEY = `render/tramos/seg_${IDX}.mp4`;

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${E.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: E.R2_ACCESS_KEY_ID, secretAccessKey: E.R2_SECRET_ACCESS_KEY },
});
const PUB = path.resolve("public");
const CLIPS = path.join(PUB, "china");

function run(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("error", rej);
    p.on("close", (c) => (c === 0 ? res() : rej(new Error(`${cmd} salió con código ${c}`))));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// bloqueDur: réplica EXACTA de la export bloqueDur de src/Vlog.tsx. Si cambia una, cambia la otra.
function bloqueDur(b, fps) {
  if (b.tipo === "habla" || b.tipo === "trading") return Math.max(1, Math.round((b.dur ?? 1) * fps));
  if (b.tipo === "trailer") return Math.round((b.dur ?? 8.4) * fps);
  if (b.tipo === "title_card") return Math.round(5.5 * fps);
  if (b.tipo === "montage") {
    const cs = b.clips ?? []; const cross = Math.round(0.3 * fps);
    return cs.reduce((s, c) => s + Math.round(c.dur * fps), 0) - Math.max(0, cs.length - 1) * cross || Math.round(6 * fps);
  }
  if (b.tipo === "cold_open")
    return (b.frags ?? []).reduce((s, fr) => s + Math.round(fr.dur * fps), 0) || Math.round(6 * fps);
  if (b.tipo === "outro") return Math.round(8 * fps);
  return fps;
}

// La fuente de video (habla/trading) según el modo, igual que fuenteUrl() de Vlog.tsx.
function fuenteFile(plan, clave) {
  const f = (plan.fuentes ?? {})[clave];
  if (!f) return null;
  return plan.modo === "proxy" ? f.proxy : f.full;
}

// Piezas (claves relativas a china/) que el tramo [from,to] necesita de R2. Solo los bloques que se
// solapan con el rango -> ahorra disco/descarga. Esquema timeline (b.tipo/b.clips/b.broll/b.fuente).
function piezasDelTramo(plan, from, to) {
  const fps = plan.fps ?? 60;
  const s = new Set();
  // Globales: cubren TODO el timeline desde el frame 0 -> todo tramo los necesita.
  if (plan.audio) s.add(plan.audio);                 // audio_full.m4a (mezcla única)
  s.add("subs/subs.json");                            // subtítulos (fetch de calcVlog)
  for (const sfx of ["audio/sfx/sub_drop.mp3", "audio/sfx/whip_swoosh.mp3", "audio/sfx/impact_cian.mp3"]) s.add(sfx);
  let acc = 0;
  for (const b of plan.timeline ?? plan.bloques ?? []) {
    const dur = bloqueDur(b, fps);
    const ini = acc, fin = acc + dur - 1;
    acc += dur;
    if (fin < from || ini > to) continue;            // no intersecta el tramo
    const fu = fuenteFile(plan, b.fuente ?? (b.tipo === "habla" || b.tipo === "trading" ? "vlog" : null));
    if (fu) s.add(fu);
    for (const c of b.clips ?? []) { if (c.clip) s.add(c.clip); }      // trailer/title_card/montage
    for (const co of b.cortes ?? []) { const cf0 = ini + Math.round((co.at ?? 0) * fps), cf1 = cf0 + Math.round((co.dur ?? 0) * fps); if (cf1 >= from && cf0 <= to && co.src) s.add(co.src); } // edicion por cortes
    for (const br of b.broll ?? []) { if (br.clip) s.add(br.clip); }   // cutaways
    for (const v of b.vertical ?? []) { if (v.clip) s.add(v.clip); if (v.clip2) s.add(v.clip2); }
    for (const f of b.frags ?? []) { if (f.video) s.add(f.video); if (f.vo?.src) s.add(f.vo.src); } // cold_open
  }
  return [...s];
}

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

async function main() {
  const plan = JSON.parse(await readFile(path.join(PUB, "render_plan.json"), "utf8"));
  const videos = piezasDelTramo(plan, FROM, TO);
  console.log(`[tramo ${IDX}] frames ${FROM}-${TO} — ${videos.length} piezas (de su rango) a bajar de R2`);

  const enR2 = await listarKeys(`${PREFIJO}/`);
  const faltan = videos.filter((v) => !enR2.has(`${PREFIJO}/${v}`));
  if (faltan.length) throw new Error(`Faltan ${faltan.length} piezas en R2: ${faltan.join(", ")}`);

  for (const [i, v] of videos.entries()) {
    const dst = path.join(CLIPS, v);
    if (existsSync(dst)) continue;
    console.log(`  [${i + 1}/${videos.length}] R2 -> ${v}`);
    await descargar(`${PREFIJO}/${v}`, dst);
  }

  const out = path.resolve("out", `seg_${IDX}.mp4`);
  await mkdir(path.dirname(out), { recursive: true });
  console.log(`[tramo ${IDX}] remotion render --frames=${FROM}-${TO} concurrency=${CONCURRENCY}`);
  await run("npx", ["remotion", "render", "Vlog", out,
    `--frames=${FROM}-${TO}`, `--concurrency=${CONCURRENCY}`,
    // El cuerpo 4K (vlog_nitido_final.mp4) pesa ~6GB; el primer seek/indexado tarda >28s
    // (default) y disparaba delayRender timeout en el frame del 1er fotograma de habla.
    // 5 min cubre el indexado inicial del archivo grande.
    `--timeout=300000`,
    `--offthreadvideo-cache-size-in-bytes=${OFFTHREAD_CACHE}`]);

  const mb = (await stat(out)).size / 1e6;
  // SKIP_UPLOAD: dejar el seg_IDX.mp4 local para que el workflow lo suba como ARTIFACT (no a R2,
  // así R2 solo guarda las fuentes y no se desborda con los tramos del 4K).
  if (E.SKIP_UPLOAD) {
    console.log(`[tramo ${IDX}] ${mb.toFixed(0)} MB local (artifact, sin R2) ✓`);
    return;
  }
  console.log(`[tramo ${IDX}] subiendo ${mb.toFixed(0)} MB -> ${OUT_KEY}`);
  await s3.send(new PutObjectCommand({ Bucket: E.R2_BUCKET, Key: OUT_KEY, Body: await readFile(out) }));
  console.log(`[tramo ${IDX}] LISTO ✓`);
}

main().catch((e) => { console.error(`tramo ${IDX} FALLÓ:`, e.message); process.exit(1); });
