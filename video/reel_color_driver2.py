#!/usr/bin/env python3
"""Driver v2: conform+color de UNA pieza desde su corte HLG, en todos los núcleos.

Uso: reel_color_driver2.py <corte.mov> <pieza.mp4> <frames_esperados> <salida.mp4>
1) ALINEACIÓN por imagen (técnica del vlog): decodifica el corte a 96x54 CFR60 y busca
   dónde cae el frame 0 de la pieza aprobada (referencias_alineacion.npz) -> offset.
   corr < 0.85 = FALLO (no adivinar nunca).
2) NPROC sub-rangos -> reel_color_worker2 -> concat frame-exacto -> count check.
3) Audio: del corte (-ss offset/60, -t dur), receta del conform (aac 192k 48k).
"""
import sys, os, subprocess, math, json
import numpy as np

FF = os.environ.get("FF", "ffmpeg")
FFP = os.environ.get("FFP", "ffprobe")
HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 96, 54
FB = W * H * 3

def nframes(path):
    r = subprocess.run([FFP, "-v", "error", "-select_streams", "v:0", "-count_packets",
                        "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", path],
                       capture_output=True, text=True)
    return int(r.stdout.strip())

def znorm(x):
    x = x - x.mean()
    return x / (x.std() + 1e-6)

def main():
    corte, pieza, esperado, out = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
    refs = np.load(os.path.join(HERE, "referencias_alineacion.npz"))
    ref = znorm(refs[pieza].astype(np.float32))
    r = subprocess.run([FF, "-nostdin", "-loglevel", "error", "-i", corte,
                        "-r", "60", "-fps_mode", "cfr", "-vf", f"scale={W}:{H}",
                        "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], capture_output=True)
    n = len(r.stdout) // FB
    frames = np.frombuffer(r.stdout[:n * FB], np.uint8).reshape(n, H, W, 3).mean(axis=3).astype(np.float32)
    corrs = [float((znorm(frames[i]) * ref).mean()) for i in range(n)]
    off = int(np.argmax(corrs))
    print(f"alineacion: offset={off} corr={corrs[off]:.3f} (corte {n} frames)", flush=True)
    if corrs[off] < 0.85:
        print("ALINEACION FALLO (corr baja)"); sys.exit(1)
    if off + esperado > n:
        print(f"CORTE CORTO: {off}+{esperado} > {n}"); sys.exit(1)

    nproc = int(os.environ.get("NPROC", "2"))
    step = math.ceil(esperado / nproc)
    ranges = [(i * step, min((i + 1) * step, esperado)) for i in range(nproc) if i * step < esperado]
    # override de exposicion por pieza (color_overrides.json: ChatGPT quemado -> exp_k 0.68)
    env = dict(os.environ)
    try:
        ov = json.load(open(os.path.join(HERE, "color_overrides.json")))
        if pieza in ov and "exp_k" in ov[pieza]:
            env["EXP_K"] = str(ov[pieza]["exp_k"])
            print(f"override exp_k={env['EXP_K']} para {pieza}", flush=True)
    except FileNotFoundError:
        pass
    procs, parts = [], []
    for k, (a, b) in enumerate(ranges):
        part = f"part_{k:02d}.mp4"; parts.append(part)
        p = subprocess.Popen([sys.executable, os.path.join(HERE, "reel_color_worker2.py"),
                              corte, str(a), str(b), str(off), part], env=env)
        procs.append(p)
    for p in procs:
        if p.wait() != 0:
            print("WORKER FALLO"); sys.exit(1)
    tot = sum(nframes(p) for p in parts)
    if tot != esperado:
        print(f"MISMATCH frames: {tot} != {esperado}"); sys.exit(1)
    with open("concat.txt", "w") as f:
        for p in parts:
            f.write(f"file '{os.path.abspath(p)}'\n")
    subprocess.run([FF, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "concat", "-safe", "0", "-i", "concat.txt", "-c", "copy", "solo_video.mp4"], check=True)
    dur = esperado / 60.0
    subprocess.run([FF, "-hide_banner", "-loglevel", "error", "-y",
        "-i", "solo_video.mp4", "-ss", f"{off / 60.0:.6f}", "-i", corte,
        "-map", "0:v:0", "-map", "1:a:0?", "-t", f"{dur:.6f}",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", out], check=True)
    final = nframes(out)
    if final != esperado:
        print(f"MISMATCH final: {final} != {esperado}"); sys.exit(1)
    print(f"PIEZA_DONE {out} ({final} frames)", flush=True)

if __name__ == "__main__":
    main()
