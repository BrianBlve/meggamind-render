#!/usr/bin/env python3
"""Driver por-runner: colorea un segmento usando todos los núcleos del runner.

Uso: color_driver.py <segmento.mp4> <seg_offset> <salida_coloreada.mp4>
Parte el segmento en NPROC sub-rangos, lanza un color_worker por núcleo en paralelo,
y concatena los sub-resultados EN ORDEN (frame-exacto).
"""
import sys, os, subprocess, json, math

FF = os.environ.get("FF", "ffmpeg")
FFP = os.environ.get("FFP", "ffprobe")
HERE = os.path.dirname(os.path.abspath(__file__))

def nframes(path):
    r = subprocess.run([FFP, "-v", "error", "-count_packets",
        "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", path],
        capture_output=True, text=True)
    return int(r.stdout.strip())

def main():
    seg, off, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    n = nframes(seg)
    nproc = int(os.environ.get("NPROC", os.cpu_count() or 4))
    step = math.ceil(n / nproc)
    ranges = [(i * step, min((i + 1) * step, n)) for i in range(nproc) if i * step < n]
    procs = []; parts = []
    for k, (a, b) in enumerate(ranges):
        part = f"part_{k:02d}.mp4"; parts.append(part)
        p = subprocess.Popen(["python3", os.path.join(HERE, "color_worker.py"),
                              seg, str(off), str(a), str(b), part])
        procs.append(p)
    for p in procs:
        if p.wait() != 0:
            print("WORKER FALLÓ", flush=True); sys.exit(1)
    # verificar suma de frames == n
    tot = sum(nframes(p) for p in parts)
    if tot != n:
        print(f"MISMATCH frames: {tot} != {n}", flush=True); sys.exit(1)
    with open("concat.txt", "w") as f:
        for p in parts:
            f.write(f"file '{os.path.abspath(p)}'\n")
    subprocess.run([FF, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "concat", "-safe", "0", "-i", "concat.txt", "-c", "copy", out], check=True)
    print(f"SEG_DONE {out} ({tot} frames)", flush=True)

if __name__ == "__main__":
    main()
