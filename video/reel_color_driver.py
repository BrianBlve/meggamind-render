#!/usr/bin/env python3
"""Driver por-runner del REEL: colorea UNA pieza con todos los núcleos.

Uso: reel_color_driver.py <pieza.mp4> <fuente> <frames_esperados> <salida.mp4>
Parte la pieza en NPROC sub-rangos -> reel_color_worker por núcleo -> concat en orden
(frame-exacto) -> re-muxea el AUDIO ORIGINAL de la pieza (algunas piezas suenan en el
Reel: visual-swap del b-roll). Verifica el frame count contra el esperado del inventario.
"""
import sys, os, subprocess, math

FF = os.environ.get("FF", "ffmpeg")
FFP = os.environ.get("FFP", "ffprobe")
HERE = os.path.dirname(os.path.abspath(__file__))

def nframes(path):
    # ffprobe count_packets (receta del vlog): `ffmpeg -c copy` en el runner NO imprime frame=
    r = subprocess.run([FFP, "-v", "error", "-select_streams", "v:0", "-count_packets",
                        "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", path],
                       capture_output=True, text=True)
    return int(r.stdout.strip())

def main():
    pieza, fuente, esperado, out = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
    n = nframes(pieza)
    if n != esperado:
        print(f"FUENTE INESPERADA: {n} frames != {esperado}", flush=True); sys.exit(1)
    nproc = int(os.environ.get("NPROC", "2"))
    step = math.ceil(n / nproc)
    ranges = [(i * step, min((i + 1) * step, n)) for i in range(nproc) if i * step < n]
    procs, parts = [], []
    for k, (a, b) in enumerate(ranges):
        part = f"part_{k:02d}.mp4"; parts.append(part)
        p = subprocess.Popen(["python3", os.path.join(HERE, "reel_color_worker.py"),
                              pieza, fuente, str(a), str(b), part])
        procs.append(p)
    for p in procs:
        if p.wait() != 0:
            print("WORKER FALLÓ", flush=True); sys.exit(1)
    tot = sum(nframes(p) for p in parts)
    if tot != n:
        print(f"MISMATCH frames: {tot} != {n}", flush=True); sys.exit(1)
    with open("concat.txt", "w") as f:
        for p in parts:
            f.write(f"file '{os.path.abspath(p)}'\n")
    subprocess.run([FF, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "concat", "-safe", "0", "-i", "concat.txt", "-c", "copy", "solo_video.mp4"], check=True)
    # audio ORIGINAL de la pieza de vuelta (mismo stream, sin recodificar)
    subprocess.run([FF, "-hide_banner", "-loglevel", "error", "-y",
        "-i", "solo_video.mp4", "-i", pieza, "-map", "0:v:0", "-map", "1:a:0",
        "-c", "copy", out], check=True)
    final = nframes(out)
    if final != esperado:
        print(f"MISMATCH final: {final} != {esperado}", flush=True); sys.exit(1)
    print(f"PIEZA_DONE {out} ({final} frames)", flush=True)

if __name__ == "__main__":
    main()
