// video/calc_reel.mjs — tramos (frameRanges) del REEL para la matrix de Actions.
// El total de frames sale de public/reel_plan.json (fuente única). SEGMENT ajusta el tamaño.
// Modo rescate: RANGOS en BASE64 (igual que calc_tramos.mjs del vlog).
import { readFile, appendFile } from "node:fs/promises";

const SEGMENT = Number(process.env.SEGMENT) || 1400;

if (process.env.RANGOS && process.env.RANGOS.trim()) {
  const matrix = Buffer.from(process.env.RANGOS.trim(), "base64").toString("utf8");
  JSON.parse(matrix);
  console.error(`RANGOS (rescate): ${matrix}`);
  await appendFile(process.env.GITHUB_OUTPUT, `matrix=${matrix}\n`);
  process.exit(0);
}

const plan = JSON.parse(await readFile("public/reel_plan.json", "utf8"));
const total = plan.frames;
if (!Number.isFinite(total) || total < 60) throw new Error(`plan.frames inválido: ${total}`);

const tramos = [];
for (let f = 0, i = 0; f < total; f += SEGMENT, i++) {
  tramos.push({ idx: String(i).padStart(2, "0"), from: f, to: Math.min(f + SEGMENT, total) - 1 });
}
const matrix = JSON.stringify(tramos);
console.error(`total=${total} frames -> ${tramos.length} tramos de ${SEGMENT}`);
console.error(matrix);
await appendFile(process.env.GITHUB_OUTPUT, `matrix=${matrix}\n`);
