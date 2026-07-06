#!/usr/bin/env python3
"""Worker de color en la nube — procesa un sub-rango de un segmento del máster.

Uso: color_worker.py <segmento.mp4> <seg_offset> <sub_from> <sub_to> <salida.mp4>
- Decodifica el segmento COMPLETO en orden (sin seek → frame-exacto), pero solo
  procesa+escribe los frames del segmento en [sub_from, sub_to).
- global_frame = seg_offset + j  → busca params en mapa_params.json y siembra el grano.
- Usa motor_color.procesar() (EL código aprobado), no versiones optimizadas.
"""
import sys, os, subprocess, json, time
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cv2
cv2.setNumThreads(1)
import motor_color as mc

FF = os.environ.get("FF", "ffmpeg")
mc.FF = FF
W, H, FPS = 3840, 2160, 60
FB = W * H * 6
MAPA = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "mapa_params.json")))

def params(fr):
    for m in MAPA:
        if m["f0"] <= fr < m["f1"]:
            return m
    return MAPA[-1]

def main():
    seg, off, a, b, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
    dec = subprocess.Popen([FF, "-hide_banner", "-loglevel", "error", "-i", seg,
        "-pix_fmt", "rgb48le", "-f", "rawvideo", "-"], stdout=subprocess.PIPE, bufsize=FB * 2)
    enc = subprocess.Popen([FF, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb48le", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
        "-c:v", "libx264", "-preset", "medium", "-crf", "12",
        "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709",
        "-color_trc", "bt709", "-g", "60", "-an", out],
        stdin=subprocess.PIPE, bufsize=FB * 2)
    j = 0; done = 0; t0 = time.time()
    while True:
        buf = dec.stdout.read(FB)
        if len(buf) < FB:
            break
        if a <= j < b:
            img = np.frombuffer(buf, np.uint16).reshape(H, W, 3)
            fr = off + j
            m = params(fr)
            rng = np.random.default_rng(fr)
            o = mc.procesar(img, {"exp": m["exp"], "wb": m["wb"], "clase": m["clase"]}, rng)
            enc.stdin.write(o.tobytes())
            done += 1
            if done % 50 == 0:
                v = (time.time() - t0) / done
                print(f"[{a}-{b}] {done}/{b-a}  {v:.2f}s/f", flush=True)
        j += 1
        if j >= b:
            break
    enc.stdin.close(); enc.wait(); dec.terminate()
    print(f"SUB_DONE {a}-{b} ({done} frames)", flush=True)

if __name__ == "__main__":
    main()
