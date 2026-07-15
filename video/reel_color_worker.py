#!/usr/bin/env python3
"""Worker de color del REEL — colorea un sub-rango de UNA pieza rsrc con el motor V3.

Uso: reel_color_worker.py <pieza.mp4> <fuente> <sub_from> <sub_to> <salida.mp4>
- esc FIJO por fuente (esc_por_fuente.json, congelado de los frames aprobados del mapa):
  cero análisis por frame -> cero flicker.
- Pre-pass (solo IMG_7754): fill de persona + dehaze con compuerta cuadrática + wb_ventana,
  con máscara DeepLabV3 POR FRAME (mismo modelo del hook). Orden validado a ojo: fill ->
  dehaze -> shift. Recetas: recetas_color.json / mapa_color.py del proyecto.
- El grano se siembra por frame absoluto de la pieza (determinista).
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
FB = W * H * 6
HERE = os.path.dirname(os.path.abspath(__file__))
ESC = json.load(open(os.path.join(HERE, "esc_por_fuente.json")))

_torch = {}
def mascara_persona(img16):
    """DeepLabV3 clase persona -> mascara 0..1 con borde duro + feather (como el hook)."""
    if not _torch:
        import torch
        from torchvision.models.segmentation import deeplabv3_resnet50, DeepLabV3_ResNet50_Weights
        _torch["t"] = torch
        _torch["m"] = deeplabv3_resnet50(weights=DeepLabV3_ResNet50_Weights.DEFAULT).eval()
        _torch["mu"] = torch.tensor([0.485, 0.456, 0.406])[:, None, None]
        _torch["sd"] = torch.tensor([0.229, 0.224, 0.225])[:, None, None]
    torch = _torch["t"]
    from PIL import Image, ImageFilter
    SW, SH = 513, 289
    im8 = Image.fromarray((img16.astype(np.float32) / 257.0 + 0.5).astype(np.uint8)).resize((SW, SH))
    t = torch.frombuffer(bytearray(im8.tobytes()), dtype=torch.uint8).reshape(SH, SW, 3)
    t = t.permute(2, 0, 1).float() / 255.0
    t = (t - _torch["mu"]) / _torch["sd"]
    with torch.no_grad():
        out = _torch["m"](t.unsqueeze(0))["out"][0]
    m = (out.argmax(0) == 15).mul(255).to(torch.uint8)
    mk = Image.frombytes("L", (SW, SH), bytes(m.flatten().tolist())).resize((W, H), Image.LANCZOS)
    mk = mk.point(lambda v: 0 if v < 128 else min(255, (v - 128) * 4)).filter(ImageFilter.GaussianBlur(9))
    return np.asarray(mk, dtype=np.float32) / 255.0

def pre_pass(img16, pre):
    if not pre:
        return img16
    mask = mascara_persona(img16) if pre.get("fill_mask") == "persona" else None
    M = mask[..., None] if mask is not None else None
    lin = m3.to_linear(img16)
    if pre.get("fill", 0) > 0:
        Y = (lin @ m3.LUMA)[..., None]
        g = np.float32(pre["fill"]) * np.exp(-Y / np.float32(pre.get("fill_piv", 0.09)))
        if M is not None:
            g = g * M
        lin = lin * (1.0 + g)
    if pre.get("dehaze", 0) > 0:
        Y = (lin @ m3.LUMA)[..., None]
        if M is not None:
            piv = np.float32(pre.get("dehaze_gate", 0.25))
            w = (Y * Y) / (Y * Y + piv * piv)
            esca = (1.0 - M) + M * w
        else:
            esca = 1.0
        v = np.float32(pre["dehaze"]) * esca
        lin = np.clip((lin - v) / (1.0 - v), 0, None)
    if pre.get("wb_ventana") and M is not None:
        wbv = np.asarray(pre["wb_ventana"], np.float32)
        lin = lin * (1.0 + (wbv[None, None, :] - 1.0) * M)
    return (m3.to_display(np.clip(lin, 0, 1)) * 65535 + 0.5).astype(np.uint16)

def main():
    pieza, fuente, a, b, out = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
    cfg = ESC[fuente]
    esc, pre = cfg["esc"], cfg.get("pre") or {}
    dec = subprocess.Popen([FF, "-hide_banner", "-loglevel", "error", "-i", pieza,
        "-pix_fmt", "rgb48le", "-f", "rawvideo", "-"], stdout=subprocess.PIPE, bufsize=FB * 2)
    enc = subprocess.Popen([FF, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb48le", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
        "-c:v", "libx264", "-preset", "medium", "-crf", "14",
        "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709",
        "-color_trc", "bt709", "-g", "12", "-an", out],
        stdin=subprocess.PIPE, bufsize=FB * 2)
    j = 0; done = 0; t0 = time.time()
    while True:
        buf = dec.stdout.read(FB)
        if len(buf) < FB:
            break
        if a <= j < b:
            img = np.frombuffer(buf, np.uint16).reshape(H, W, 3)
            img = pre_pass(img, pre)
            o = m3.procesar_v3(img, esc, j)
            enc.stdin.write(o.tobytes())
            done += 1
            if done % 25 == 0:
                print(f"[{a}-{b}] {done}/{b - a}  {(time.time() - t0) / done:.2f}s/f", flush=True)
        j += 1
        if j >= b:
            break
    enc.stdin.close(); enc.wait(); dec.terminate()
    print(f"WORKER_DONE {out} ({done} frames)", flush=True)

if __name__ == "__main__":
    main()
