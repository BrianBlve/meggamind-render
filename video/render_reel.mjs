// Render del Reel de prueba: baja el clip de R2 -> `remotion render Reel --scale=2` -> sube el MP4.
// Env: R2_* (cuenta/llaves/bucket). Un solo runner (600 frames).
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { execSync } from "node:child_process";

const E = process.env;
const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${E.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: E.R2_ACCESS_KEY_ID, secretAccessKey: E.R2_SECRET_ACCESS_KEY },
});

async function bajar(key, destino) {
  const r = await s3.send(new GetObjectCommand({ Bucket: E.R2_BUCKET, Key: key }));
  await pipeline(r.Body, createWriteStream(destino));
  console.log(`R2 -> ${destino}`);
}

await mkdir("public/reel", { recursive: true });
await mkdir("out", { recursive: true });
await bajar("reel/base_sdr_10s.mp4", "public/reel/base_sdr_10s.mp4");

execSync(
  "npx remotion render Reel out/reel_prueba.mp4 --scale=2 --codec=h264 --crf=16 --concurrency=2 --log=info",
  { stdio: "inherit" },
);

const body = await readFile("out/reel_prueba.mp4");
await s3.send(new PutObjectCommand({
  Bucket: E.R2_BUCKET,
  Key: "reel/out/reel_prueba.mp4",
  Body: body,
  ContentType: "video/mp4",
}));
console.log(`Subido reel/out/reel_prueba.mp4 (${(body.length / 1e6).toFixed(1)} MB)`);
