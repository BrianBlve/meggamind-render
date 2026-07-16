#!/usr/bin/env python3
"""Worker v2 del REEL — conform + color EN UNO desde el corte HLG crudo:

  corte HLG 10bit (-c copy del MOV, +1s colchón)
    -> decode CFR60 + zscale a LINEAL (npl=1000, primarios 2020, float32)
    -> INGESTA BT.2390 (motor_hdr): EETF + gamut 2020->709  == la base que Brian aprobó
    -> TEXTURA del motor V3 (contraste local suave, piel orgánica, halation, grano)
       [TEXTURA=0 -> base pura]
    -> x264 crf14 g12 bt709

Uso: reel_color_worker2.py <corte.mov> <sub_from> <sub_to> <offset_frames> <salida.mp4>
El offset (dónde cae el frame 0 de la pieza dentro del corte) lo calcula el driver por
matching de imagen contra la pieza aprobada (referencias_alineacion.npz).
"""
import sys, os, subprocess, time
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cv2
cv2.setNumThreads(1)
import motor_color_v3 as m3
import motor_hdr as mh

FF = os.environ.get("FF", "ffmpeg")
m3.FF = FF
mh.FF = FF
TEXTURA = os.environ.get("TEXTURA", "1") == "1"
W, H, FPS = 3840, 2160, 60
FB = W * H * 3 * 4  # gbrpf32le

def textura(img16, fidx):
    lin = m3.to_linear(img16)
    disp0 = m3.to_display(lin)
    piel = m3.mascara_piel(disp0)
    lin = m3.contraste_local(lin, piel, gain_base=0.14, gain_det=0.06)
    lin = m3.piel_organica(lin, piel)
    disp = m3.to_display(np.clip(lin, 0.0, 4.0))
    disp = m3.halation(disp, fuerza=0.04)
    disp = m3.grano_dither(disp, fidx)
    return (disp * 65535.0 + 0.5).astype(np.uint16)

def main():
    corte, a, b, off, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
    exp_k = float(os.environ.get("EXP_K", "1.0"))   # override por pieza (ChatGPT: 0.68 anti-quemado)
    dec = subprocess.Popen([FF, "-hide_banner", "-loglevel", "error", "-i", corte,
        "-r", str(FPS), "-fps_mode", "cfr",
        "-vf", f"zscale=w={W}:h={H}:f=spline36,zscale=tin=arib-std-b67:t=linear:npl=1000",
        "-pix_fmt", "gbrpf32le", "-f", "rawvideo", "-"], stdout=subprocess.PIPE, bufsize=FB * 2)
    enc = subprocess.Popen([FF, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb48le", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
        "-c:v", "libx264", "-preset", "medium", "-crf", "14",
        "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709",
        "-color_trc", "bt709", "-g", "12", "-an", out],
        stdin=subprocess.PIPE, bufsize=W * H * 6 * 2)
    j = 0; done = 0; t0 = time.time()
    ini, fin = off + a, off + b
    while True:
        buf = dec.stdout.read(FB)
        if len(buf) < FB:
            break
        if ini <= j < fin:
            g, bl, r = np.frombuffer(buf, np.float32).reshape(3, H, W)
            lin2020 = np.stack([r, g, bl], axis=-1)
            lin709 = mh.hlg_a_sdr709_lineal(lin2020)
            if exp_k != 1.0:
                lin709 = np.clip(lin709 * np.float32(exp_k), 0.0, 1.0)
            img16 = (np.power(np.clip(lin709, 0.0, 1.0), 1.0 / 2.4) * 65535.0 + 0.5).astype(np.uint16)
            o = textura(img16, a + done) if TEXTURA else img16
            enc.stdin.write(np.ascontiguousarray(o).tobytes())
            done += 1
            if done % 25 == 0:
                print(f"[{a}-{b}] {done}/{b - a}  {(time.time() - t0) / done:.2f}s/f", flush=True)
        j += 1
        if j >= fin:
            break
    enc.stdin.close(); enc.wait(); dec.terminate()
    if done != b - a:
        print(f"FRAMES INSUFICIENTES: {done} != {b - a}", flush=True); sys.exit(1)
    print(f"WORKER_DONE {out} ({done} frames)", flush=True)

if __name__ == "__main__":
    main()
