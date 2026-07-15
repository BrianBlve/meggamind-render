#!/usr/bin/env python3
"""Colorea hook_alpha.webm (capa de persona con ALPHA del hook) con el esc de IMG_7747,
para que el recorte calce EXACTO con la pieza de fondo coloreada.

Uso: reel_color_alpha.py <hook_alpha.webm> <salida.webm>
Decodifica rgba64le -> motor V3 SOLO en RGB (alpha intacto) -> re-encode VP9 yuva420p.
"""
import sys, os, subprocess, json, time
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cv2
cv2.setNumThreads(1)
import motor_color_v3 as m3

FF = os.environ.get("FF", "ffmpeg")
m3.FF = FF
W, H, FPS = 3840, 2160, 60
FB = W * H * 8  # rgba64le
HERE = os.path.dirname(os.path.abspath(__file__))
ESC = json.load(open(os.path.join(HERE, "esc_por_fuente.json")))["IMG_7747"]["esc"]

def main():
    src, out = sys.argv[1], sys.argv[2]
    dec = subprocess.Popen([FF, "-hide_banner", "-loglevel", "error",
        "-c:v", "libvpx-vp9", "-i", src,
        "-pix_fmt", "rgba64le", "-f", "rawvideo", "-"], stdout=subprocess.PIPE, bufsize=FB * 2)
    enc = subprocess.Popen([FF, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgba64le", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
        "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-crf", "34", "-b:v", "0",
        "-row-mt", "1", "-speed", "6", "-an", out], stdin=subprocess.PIPE, bufsize=FB * 2)
    j = 0; t0 = time.time()
    while True:
        buf = dec.stdout.read(FB)
        if len(buf) < FB:
            break
        px = np.frombuffer(buf, np.uint16).reshape(H, W, 4)
        rgb = np.ascontiguousarray(px[..., :3])
        o = m3.procesar_v3(rgb, ESC, j)
        rgba = np.dstack([o, px[..., 3]])
        enc.stdin.write(np.ascontiguousarray(rgba).tobytes())
        j += 1
        if j % 25 == 0:
            print(f"{j} frames  {(time.time() - t0) / j:.2f}s/f", flush=True)
    enc.stdin.close(); enc.wait(); dec.wait()
    print(f"ALPHA_DONE {out} ({j} frames)", flush=True)

if __name__ == "__main__":
    main()
