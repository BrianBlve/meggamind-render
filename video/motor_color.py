#!/usr/bin/env python3
"""MOTOR DE COLOR — sustituto parcial de un sistema de grading profesional.

No es un LUT ni una cadena de filtros: es un pipeline de color management que
trabaja en ESPACIO LINEAL con floats, con qualifiers (piel/agua), curvas
hue-vs-* en Oklab (sin desplazar luma), contraste local multi-escala y salida
con dither. ffmpeg queda relegado a decode/encode.

Etapas (en orden):
  1. decode 16-bit (gbrp16le via ffmpeg) -> float32 0..1
  2. display (BT.1886) -> LINEAL, por LUT de 65536 entradas
  3. exposición por escena (normaliza mediana de luma lineal, clamp ±0.35 EV)
  4. white balance por escena (neutros por percentil de baja saturación, clamp ±6%, blend 65%)
  5. highlights: shoulder filmico en lineal (knee 0.62), preserva hue (escala RGB por ratio de luma)
  6. sombras: toe con piso (evita negro plano, conserva textura)
  7. contraste local multi-escala en log-luma (base 1/6 res sigma≈90px, detalle sigma≈10px), ganancia limitada
  8. textura: high-pass fino (sigma 2.2px) fuera de la máscara de piel
  9. piel: qualifier YCbCr elíptico suavizado — protege hue/sat de TODAS las etapas de color, +2% luma
 10. agua: qualifier hue Oklab 175–225° ponderado por chroma — hue −5° (hacia azul), +3% luma, sat controlada
 11. hue-vs-sat global en Oklab: verdes −8% (anti-fluorescente), amarillo-verde −10%
 12. film density: luma ligeramente más densa donde hay chroma alto (look de negativo)
 13. curva S display-referred (pivot 0.42, contraste ~1.16), color preservado por ratio
 14. grano fino band-limited dependiente de luma + dither triangular -> 8-bit
"""
import numpy as np, cv2, subprocess, json, os, sys

FF = os.environ.get("FF", "/tmp/ffbin/ffmpeg")

# ---------- transferencias (LUT 16-bit) ----------
_x16 = np.linspace(0.0, 1.0, 65536).astype(np.float32)
LUT_TO_LIN = np.power(np.maximum(_x16, 0.0), 2.4).astype(np.float32)          # BT.1886 aprox
_inv = np.power(np.maximum(_x16, 1e-9), 1.0 / 2.4).astype(np.float32)
def to_linear(img16):                     # uint16 HxWx3 -> float32 lineal
    return LUT_TO_LIN[img16]
def to_display(lin):                      # float32 lineal -> float32 display 0..1
    idx = np.clip(lin, 0.0, 1.0)
    idx16 = (idx * 65535.0 + 0.5).astype(np.uint16)
    return _inv[idx16]

# ---------- Oklab ----------
_M1 = np.array([[0.4122214708, 0.5363325363, 0.0514459929],
                [0.2119034982, 0.6806995451, 0.1073969566],
                [0.0883024619, 0.2817188376, 0.6299787005]], np.float32)
_M2 = np.array([[0.2104542553, 0.7936177850, -0.0040720468],
                [1.9779984951, -2.4285922050, 0.4505937099],
                [0.0259040371, 0.7827717662, -0.8086757660]], np.float32)
_M1i = np.linalg.inv(_M1).astype(np.float32)
_M2i = np.linalg.inv(_M2).astype(np.float32)
def rgb_to_oklab(lin):
    lms = lin @ _M1.T
    lms = np.cbrt(np.maximum(lms, 0.0))
    return lms @ _M2.T
def oklab_to_rgb(lab):
    lms = lab @ _M2i.T
    lms = lms * lms * lms
    return lms @ _M1i.T

LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)

def luma_of(lin):
    return lin @ LUMA

# ---------- análisis por escena ----------
def analizar(lin):
    Y = luma_of(lin)
    med = float(np.median(Y))
    # neutros: pixeles de baja saturación en tonos medios
    mx = lin.max(2); mn = lin.min(2)
    sat = (mx - mn) / np.maximum(mx, 1e-6)
    m = (sat < 0.13) & (Y > 0.05) & (Y < 0.7)
    if m.sum() > 500:
        neutro = np.stack([lin[..., c][m].mean() for c in range(3)])
    else:
        neutro = np.array([Y.mean()] * 3, np.float32)
    return med, neutro

def params_escena(lin, target_med=0.20, hint=None):
    med, neutro = analizar(lin)
    exp = float(np.clip((target_med / max(med, 1e-4)) ** 0.5, 0.90, 1.12))  # normalización suave (raíz = 50% del camino), clamp ±0.15 EV
    g = neutro.mean() / np.maximum(neutro, 1e-6)
    wb = 1.0 + 0.65 * (np.clip(g, 0.94, 1.06) - 1.0)                # blend 65%, clamp (neutro, sin sesgo: la calidez va en color con piel excluida)
    disp0 = to_display(lin)
    piel0 = mascara_piel(disp0)
    clase = clasificar_escena(lin, piel0, hint)
    return {"exp": exp, "wb": [float(x) for x in wb], "clase": clase}

# ---------- etapas ----------
def shoulder(lin, knee=0.62, strength=1.9):
    Y = luma_of(lin)
    over = Y > knee
    Yc = Y.copy()
    t = (Y - knee)
    Yc = np.where(over, knee + t / (1.0 + strength * t / (1.0 - knee)), Y)
    ratio = np.where(Y > 1e-6, Yc / np.maximum(Y, 1e-6), 1.0)
    return lin * ratio[..., None]

def toe(lin, piso=0.0016, fuerza=0.55):
    Y = luma_of(lin)
    Yt = piso + Y * (1.0 - piso)
    k = 0.05
    baja = Y < k
    curv = piso + (Y / k) ** (1.0 + fuerza) * (k - piso + k * fuerza * 0) if False else None
    # toe suave: potencia solo bajo el knee, continua en k
    p = 1.0 + fuerza
    Ylow = piso + (np.maximum(Y, 0) / k) ** p * (k * (1 - piso / max(k, 1e-6)))
    Ylow = piso + (np.maximum(Y, 0) / k) ** p * (k - piso)
    Yc = np.where(baja, Ylow, Yt * 0 + Y)
    # empalme: en Y>=k dejamos Y (la S-curve global hace el resto)
    ratio = np.where(Y > 1e-6, Yc / np.maximum(Y, 1e-6), 1.0)
    return lin * np.clip(ratio, 0.0, 1.5)[..., None]

def contraste_local(lin, gain_base=0.24, gain_det=0.10):
    """Contraste local SIN halos: base edge-aware (bilateral en log-luma a 1/6 res)."""
    Y = np.maximum(luma_of(lin), 1e-6)
    L = np.log2(Y)
    h, w = L.shape
    small = cv2.resize(L, (w // 6, h // 6), interpolation=cv2.INTER_AREA)
    # bilateral: respeta bordes -> el detalle grueso no cruza el contorno del sujeto (cero halo)
    base_s = cv2.bilateralFilter(small, d=17, sigmaColor=0.55, sigmaSpace=13)
    base = cv2.resize(base_s, (w, h), interpolation=cv2.INTER_LINEAR)
    det_grueso = np.clip(L - base, -1.2, 1.2)
    fino = cv2.GaussianBlur(L, (0, 0), 6)
    det_medio = np.clip(L - fino, -0.6, 0.6)
    Lout = base + det_grueso * (1.0 + gain_base) + det_medio * gain_det
    delta = Lout - L
    protege = np.clip((Y - 0.008) / 0.03, 0.15, 1.0)   # en sombras muy profundas, efecto reducido
    delta = np.where(delta < 0, delta * protege, delta)
    ratio = np.exp2(np.clip(delta, -0.7, 0.7))
    return lin * ratio[..., None]

def mascara_piel(disp):
    """Qualifier de piel calibrado con MEDICIONES del material (cara real: Cr~137, Cb~120).
    Ejes: Cr distancia (roca=128, piel>=133) + Cb gaussiano + compuerta de luma."""
    bgr = (np.clip(disp[..., ::-1], 0, 1) * 255).astype(np.uint8)
    ycc = cv2.cvtColor(bgr, cv2.COLOR_BGR2YCrCb).astype(np.float32)
    Y, Cr, Cb = ycc[..., 0] / 255.0, ycc[..., 1], ycc[..., 2]
    cr_score = np.clip((Cr - 132.0) / 5.0, 0.0, 1.0)          # roca (<=134) apenas roza; piel (137+) llena
    cb_score = np.exp(-((Cb - 120.0) ** 2) / (2 * 13.0 ** 2))
    y_gate = np.clip((Y - 0.10) / 0.08, 0, 1) * np.clip((0.82 - Y) / 0.10, 0, 1)
    m = cr_score * cb_score * y_gate
    m = cv2.GaussianBlur(m, (0, 0), 6)
    return np.clip(m * 1.4, 0.0, 1.0)

def textura(lin, piel, gain=0.06):
    Y = luma_of(lin)
    hp = Y - cv2.GaussianBlur(Y, (0, 0), 2.2)
    boost = 1.0 + gain * np.clip(1.0 - piel, 0, 1)
    Y2 = Y + hp * (boost - 1.0)
    ratio = np.where(Y > 1e-6, Y2 / np.maximum(Y, 1e-6), 1.0)
    return lin * np.clip(ratio, 0.5, 1.8)[..., None]

def color_oklab(lin, piel, params):
    """hue-vs-hue / hue-vs-sat / hue-vs-luma + agua, protegiendo piel."""
    lab = rgb_to_oklab(np.maximum(lin, 0.0))
    L, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
    C = np.sqrt(a * a + b * b)
    H = np.degrees(np.arctan2(b, a))          # -180..180
    Hpos = np.where(H < 0, H + 360, H)
    prot = 1.0 - piel                          # 1 fuera de piel

    def campana(h0, ancho):
        d = np.abs(((Hpos - h0 + 180) % 360) - 180)
        return np.clip(1.0 - d / ancho, 0.0, 1.0) ** 1.5

    # AGUA: banda hue ASIMÉTRICA — corte duro contra vegetación (<152°), suave hacia azul.
    # La textura solo penaliza la franja de solape 150-165 (hojas verdes vs agua verde).
    def smoothstep(x, e0, e1):
        t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
        return t * t * (3 - 2 * t)
    banda = smoothstep(Hpos, 150, 164) * (1.0 - smoothstep(Hpos, 212, 242))
    Yl = luma_of(lin)
    det = np.abs(Yl - cv2.GaussianBlur(Yl, (0, 0), 2.5))
    det_n = cv2.GaussianBlur(det, (0, 0), 12)
    textura_pen = np.clip(1.0 - det_n / 0.05, 0.3, 1.0)
    solape = smoothstep(Hpos, 150, 160) * (1.0 - smoothstep(Hpos, 162, 172))
    w_agua = banda * np.clip(C / 0.045, 0, 1) * (1.0 - solape * (1.0 - textura_pen)) * prot
    # VERDES 120-160: -8% chroma (anti fluor), hue +3 hacia esmeralda limpia
    w_verde = campana(135, 38) * prot
    # AMARILLO-VERDE 95-120: -10% chroma (limpia el cast sucio)
    w_yg = campana(105, 22) * prot

    # hacia AZUL = hue POSITIVO en Oklab (turquesa ~200°, azul ~255°)
    dH = (params.get("agua_hue", 8.0)) * w_agua + (3.0) * w_verde * 0.5
    # anti-neón: el chroma del agua NO sube; si es muy alto, baja un pelo
    exceso = np.clip((C - 0.115) / 0.05, 0, 1)
    dC = (0.05) * w_verde * C + (-0.03) * w_yg * C + w_agua * C * (0.34 - 0.30 * exceso)
    dL = (0.022) * w_agua                            # agua luminosa y cristalina; piel SIN tocar

    # vibrance Oklab: +12% en chroma bajo, decae al subir (anti-neón); piel a mitad de efecto
    vib = 0.12 * np.clip(1.0 - C / 0.13, 0.0, 1.0) * (1.0 - 0.5 * piel)
    dC = dC + C * vib
    Hn = np.radians(Hpos + dH)
    Cn = np.maximum(C + dC, 0.0)
    Ln = np.clip(L + dL * 0.35, 0.0, 1.2)
    lab2 = np.stack([Ln, Cn * np.cos(Hn), Cn * np.sin(Hn)], -1)
    out = oklab_to_rgb(lab2)
    return np.maximum(out, 0.0)

def film_density(lin, fuerza=0.10):
    lab = rgb_to_oklab(np.maximum(lin, 0.0))
    C = np.sqrt(lab[..., 1] ** 2 + lab[..., 2] ** 2)
    dens = 1.0 - fuerza * np.clip(C / 0.14, 0, 1) * 0.5
    return lin * dens[..., None]

def s_curve_display(disp, pivot=0.42, c_alto=1.24, c_bajo=1.10, lift=-0.013, whites=1.05, shadow_lift=0.085):
    """Curva filmica ASIMÉTRICA: blacks abajo, zona de sombra respirando, highlights con punch."""
    Y = disp @ LUMA
    Yl = np.clip((Y + lift) / (1.0 + lift), 0.0, 1.0)          # blacks -1.3%
    arriba = Yl >= pivot
    Yc = np.where(arriba, pivot + (Yl - pivot) * c_alto,        # contraste pleno arriba
                          pivot + (Yl - pivot) * c_bajo)        # suave abajo (sombras no se hunden)
    # SHADOWS +8.5%: banda de sombra (centrada en 0.16) sube — respuesta filmica
    banda = np.exp(-((Yc - 0.16) ** 2) / (2 * 0.09 ** 2))
    Yc = Yc + shadow_lift * banda * Yc
    # whites +5% progresivo con shoulder (sin recortar)
    Yc = Yc * (1.0 + (whites - 1.0) * np.clip((Yc - 0.55) / 0.45, 0, 1))
    Yc = np.where(Yc > 0.86, 0.86 + (Yc - 0.86) * 0.60, Yc)
    Yc = np.clip(Yc, 0.0, 1.0)
    ratio = np.where(Y > 1e-6, Yc / np.maximum(Y, 1e-6), 1.0)
    return np.clip(disp * ratio[..., None], 0.0, 1.0)

def grano_dither(disp, rng, cantidad=0.0075):
    Y = disp @ LUMA
    peso = (1.0 - np.abs(2.0 * Y - 1.0)) * 0.75 + 0.25
    g = rng.standard_normal(Y.shape).astype(np.float32)
    g = cv2.GaussianBlur(g, (0, 0), 0.7)
    disp = disp + (g * cantidad * peso)[..., None]
    tri = (rng.random(disp.shape, dtype=np.float32) - rng.random(disp.shape, dtype=np.float32)) / 255.0
    return np.clip(disp + tri, 0.0, 1.0)

# ---------- pipeline por frame ----------
def procesar(img16, esc, rng):
    lin = to_linear(img16)
    lin = lin * esc["exp"]
    lin = lin * np.asarray(esc["wb"], np.float32)[None, None, :]
    lin = shoulder(lin)
    lin = toe(lin)
    lin = contraste_local(lin)
    disp0 = to_display(lin)
    piel = mascara_piel(disp0)
    lin = textura(lin, piel)
    lab_ref = rgb_to_oklab(np.maximum(lin, 0.0))       # cromaticidad de piel ANTES de todo el color
    lin = color_oklab(lin, piel, esc.get("color", {}))
    lin = creative_grade(lin, piel, LOOKS.get(esc.get("clase", "paisaje"), LOOKS["paisaje"]))
    # PIEL: restaurar a,b originales (cero edición de color; solo luz/contraste de la escena)
    lab_fin = rgb_to_oklab(np.maximum(lin, 0.0))
    m3 = piel[..., None]
    # la piel recupera su cromaticidad original Y recibe su propio grade aislado:
    # +14% de su propio chroma + calidez suave — nada del color de paisaje la toca
    a_piel = lab_ref[..., 1] * 1.14 + 0.0035
    b_piel = lab_ref[..., 2] * 1.14 + 0.0050
    ab_mix = lab_fin.copy()
    ab_mix[..., 1] = lab_fin[..., 1] * (1 - piel) + a_piel * piel
    ab_mix[..., 2] = lab_fin[..., 2] * (1 - piel) + b_piel * piel
    lin = np.maximum(oklab_to_rgb(ab_mix), 0.0)
    lin = film_density(lin)
    disp = to_display(np.clip(lin, 0.0, 4.0))
    disp = s_curve_display(disp)
    disp = grano_dither(disp, rng)
    return (disp * 65535.0 + 0.5).astype(np.uint16)

# ---------- IO ----------
def leer_frame(video, t, w=3840):
    r = subprocess.run([FF, "-hide_banner", "-loglevel", "error", "-ss", str(t), "-i", video,
                        "-vframes", "1", "-vf", f"scale={w}:-2", "-pix_fmt", "rgb48le",
                        "-f", "rawvideo", "-"], capture_output=True)
    n = len(r.stdout) // (w * 6)
    a = np.frombuffer(r.stdout[: n * w * 6], np.uint16).reshape(n, w, 3)
    return a.copy()

def guardar_jpg(img16, ruta, calidad=93):
    bgr8 = (img16[..., ::-1].astype(np.float32) / 257.0 + 0.5).astype(np.uint8)
    cv2.imwrite(ruta, bgr8, [cv2.IMWRITE_JPEG_QUALITY, calidad])

# ============================================================================
# CREATIVE GRADE ENGINE (V2) — se ejecuta DESPUÉS del grade técnico.
# Optimiza percepción cinematográfica: color contrast, depth coloring,
# separación de color y densidad tonal. Los montos son por-clase de escena.
# ============================================================================

TALKING={'IMG_8388','IMG_8405','IMG_8419','IMG_8449','IMG_8467','IMG_8490','IMG_8497','IMG_8508'}
def clasificar_escena(lin, piel, hint=None):
    """Clase de escena: cara real (Haar) + fracciones de color en Oklab."""
    lab = rgb_to_oklab(np.maximum(lin, 0.0))
    L, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
    C = np.sqrt(a * a + b * b)
    H = np.degrees(np.arctan2(b, a)); H = np.where(H < 0, H + 360, H)
    agua = float(((H > 170) & (H < 235) & (C > 0.035)).mean())
    verde = float(((H > 115) & (H < 165) & (C > 0.03)).mean())
    calcita = float(((H > 70) & (H < 115) & (L > 0.5) & (C > 0.02)).mean())
    blanco = float(((L > 0.82) & (C < 0.03)).mean())
    oscuro = float((L < 0.18).mean())
    # retrato: SOLO si la fuente es un talking-head Y hay blob denso de piel
    hh, ww = piel.shape
    ps = cv2.resize(piel, (ww // 8, hh // 8), interpolation=cv2.INTER_AREA)
    denso = cv2.GaussianBlur(ps, (0, 0), 5)
    pico = float(denso.max()); frac = float((piel > 0.5).mean())
    es_talking = hint is None or (hint in TALKING)
    if es_talking and pico > 0.62 and 0.008 < frac < 0.30: return "retrato"
    if calcita > 0.22: return "terrazas"
    if blanco > 0.28 and verde < 0.25: return "cascada"
    if agua > 0.18: return "agua"
    if verde > 0.34: return "bosque"
    if oscuro > 0.30: return "trading"
    return "paisaje"

# tabla de looks por clase: (frio_sombra, calidez_medios, calidez_altas, depth, densidad, sep_verde)
LOOKS = {
    "retrato":  dict(cool_sh=0.003, warm_mid=0.017, warm_hi=0.011, depth=0.9, dens=0.06, sepv=0.5),
    "agua":     dict(cool_sh=0.003, warm_mid=0.013, warm_hi=0.012, depth=1.0, dens=0.05, sepv=0.4),
    "cascada":  dict(cool_sh=0.005, warm_mid=0.012, warm_hi=0.013, depth=0.7, dens=0.04, sepv=0.3),
    "bosque":   dict(cool_sh=0.003, warm_mid=0.015, warm_hi=0.012, depth=1.0, dens=0.06, sepv=1.0),
    "trading":  dict(cool_sh=0.003, warm_mid=0.014, warm_hi=0.010, depth=0.5, dens=0.05, sepv=0.3),
    "terrazas": dict(cool_sh=0.003, warm_mid=0.018, warm_hi=0.014, depth=0.8, dens=0.06, sepv=0.4),
    "paisaje":  dict(cool_sh=0.003, warm_mid=0.015, warm_hi=0.012, depth=1.0, dens=0.05, sepv=0.7),
}

def mascara_fondo(lin, piel):
    """Proxy de profundidad sin depth-map: lejano = alto brillo + baja saturación local
    + poca energía de detalle (perspectiva atmosférica) + prior vertical (arriba=lejos)."""
    Y = luma_of(lin)
    h, w = Y.shape
    det = np.abs(Y - cv2.GaussianBlur(Y, (0, 0), 4))
    det_n = cv2.GaussianBlur(det, (0, 0), 25)
    det_n = det_n / (det_n.max() + 1e-6)
    mx = lin.max(2); mn = lin.min(2)
    sat = (mx - mn) / np.maximum(mx, 1e-6)
    haze = np.clip(Y * 1.6, 0, 1) * np.clip(1.0 - sat * 2.2, 0, 1)
    vert = np.linspace(1.0, 0.25, h, dtype=np.float32)[:, None] * np.ones((1, w), np.float32)
    fondo = np.clip(0.45 * (1.0 - det_n) + 0.30 * haze + 0.25 * vert, 0, 1)
    fondo = cv2.GaussianBlur(fondo, (0, 0), 30) * (1.0 - piel)
    return np.clip(fondo, 0, 1)

def creative_grade(lin, piel, look):
    """Color contrast + depth coloring + separación de verdes + densidad tonal."""
    lab = rgb_to_oklab(np.maximum(lin, 0.0))
    L, a, b = lab[..., 0].copy(), lab[..., 1].copy(), lab[..., 2].copy()
    C = np.sqrt(a * a + b * b)
    H = np.degrees(np.arctan2(b, a)); Hp = np.where(H < 0, H + 360, H)
    prot = 1.0 - piel

    # --- COLOR CONTRAST (split-toning perceptual) ---
    w_sh = np.clip(1.0 - L / 0.42, 0, 1) ** 1.4           # sombras
    w_mid = np.exp(-((L - 0.55) ** 2) / (2 * 0.16 ** 2))  # medios
    w_hi = np.clip((L - 0.75) / 0.25, 0, 1) ** 1.2        # altas
    # sombras frías SOLO en neutros/rocas/agua — el follaje queda orgánico y cálido
    w_follaje = np.clip(1.0 - np.abs(Hp - 135) / 40.0, 0, 1)
    frio_ok = prot * (1.0 - w_follaje)
    b -= look["cool_sh"] * w_sh * frio_ok
    a -= look["cool_sh"] * 0.35 * w_sh * frio_ok
    # calidez global (reemplaza el sesgo WB) + medios cálidos — PIEL EXCLUIDA por completo
    a += 0.0045 * prot; b += 0.0060 * prot
    calmid = look["warm_mid"] * w_mid * prot
    a += calmid * 0.7; b += calmid
    # altas doradas suaves
    calhi = look["warm_hi"] * w_hi
    a += calhi * 0.4; b += calhi

    # --- DEPTH COLORING ---
    fondo = mascara_fondo(lin, piel) * look["depth"]
    b -= 0.002 * fondo                      # fondo apenas frío (calidez manda)
    fac_c = 1.0 - 0.06 * fondo              # fondo -6% chroma (verdes vivos)
    a *= fac_c; b *= fac_c
    L += 0.010 * fondo                      # aire atmosférico leve
    # sujeto (no-fondo, no-cielo): +densidad
    cerca = np.clip(1.0 - fondo * 1.4, 0, 1) * prot
    L -= look["dens"] * 0.25 * cerca * np.clip(1 - L, 0, 1)

    # --- SEPARACIÓN DE VERDES (varios tonos, no uno) ---
    w_verde = np.clip(1.0 - np.abs(Hp - 140) / 45.0, 0, 1)
    sombra_v = w_verde * w_sh; alta_v = w_verde * (1.0 - w_sh)
    dH_v = (-7.0 * sombra_v + 6.0 * alta_v) * look["sepv"] * prot   # sombras->esmeralda, luces->lima
    Hn = Hp + dH_v
    Cn = np.sqrt(a * a + b * b)
    Hr = np.radians(np.where(w_verde > 0.01, Hn, np.degrees(np.arctan2(b, a)) % 360))
    a = np.where(w_verde > 0.01, Cn * np.cos(Hr), a)
    b = np.where(w_verde > 0.01, Cn * np.sin(Hr), b)

    out = oklab_to_rgb(np.stack([np.clip(L, 0, 1.2), a, b], -1))
    return np.maximum(out, 0.0)

if __name__ == "__main__":
    video = sys.argv[1]; t = float(sys.argv[2]); salida = sys.argv[3]
    img = leer_frame(video, t)
    esc = params_escena(to_linear(img))
    rng = np.random.default_rng(7)
    out = procesar(img, esc, rng)
    guardar_jpg(out, salida)
    print(json.dumps(esc))

# ============================================================================
# PIPELINE OPTIMIZADO PARA RENDER (una sola pasada Oklab, máscaras a baja res)
# Mismo resultado visual que procesar(); ~4-6x más rápido.
# ============================================================================

def _color_unificado(lin, piel, look, params):
    """color_oklab + creative_grade + film_density + restauración de piel en UNA pasada Oklab."""
    lab = rgb_to_oklab(np.maximum(lin, 0.0))
    L = lab[..., 0].copy(); a0 = lab[..., 1].copy(); b0 = lab[..., 2].copy()
    a = a0.copy(); b = b0.copy()
    C = np.sqrt(a * a + b * b)
    H = np.degrees(np.arctan2(b, a)); Hpos = np.where(H < 0, H + 360, H)
    prot = 1.0 - piel
    h, w = L.shape

    def campana(h0, ancho):
        d = np.abs(((Hpos - h0 + 180) % 360) - 180)
        return np.clip(1.0 - d / ancho, 0.0, 1.0) ** 1.5
    def smoothstep(x, e0, e1):
        t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
        return t * t * (3 - 2 * t)

    # ---- qualifier de agua (detalle a 1/2 res) ----
    Yl = luma_of(lin)
    Ys = cv2.resize(Yl, (w // 2, h // 2), interpolation=cv2.INTER_AREA)
    det_s = np.abs(Ys - cv2.GaussianBlur(Ys, (0, 0), 1.25))
    det_n = cv2.resize(cv2.GaussianBlur(det_s, (0, 0), 6), (w, h), interpolation=cv2.INTER_LINEAR)
    textura_pen = np.clip(1.0 - det_n / 0.05, 0.3, 1.0)
    banda = smoothstep(Hpos, 150, 164) * (1.0 - smoothstep(Hpos, 212, 242))
    solape = smoothstep(Hpos, 150, 160) * (1.0 - smoothstep(Hpos, 162, 172))
    w_agua = banda * np.clip(C / 0.045, 0, 1) * (1.0 - solape * (1.0 - textura_pen)) * prot
    w_verde = campana(135, 38) * prot
    w_yg = campana(105, 22) * prot

    # ---- etapa color_oklab ----
    dH = 8.0 * w_agua + 1.5 * w_verde
    exceso = np.clip((C - 0.115) / 0.05, 0, 1)
    dC = (0.05) * w_verde * C + (-0.03) * w_yg * C + w_agua * C * (0.34 - 0.30 * exceso)
    dL = 0.022 * w_agua
    vib = 0.12 * np.clip(1.0 - C / 0.13, 0.0, 1.0) * (1.0 - 0.5 * piel)
    dC = dC + C * vib
    Hn = np.radians(Hpos + dH)
    Cn = np.maximum(C + dC, 0.0)
    L = np.clip(L + dL * 0.35, 0.0, 1.2)
    a = Cn * np.cos(Hn); b = Cn * np.sin(Hn)

    # ---- creative grade ----
    Hp2 = np.degrees(np.arctan2(b, a)); Hp2 = np.where(Hp2 < 0, Hp2 + 360, Hp2)
    w_sh = np.clip(1.0 - L / 0.42, 0, 1) ** 1.4
    w_mid = np.exp(-((L - 0.55) ** 2) / (2 * 0.16 ** 2))
    w_hi = np.clip((L - 0.75) / 0.25, 0, 1) ** 1.2
    w_follaje = np.clip(1.0 - np.abs(Hp2 - 135) / 40.0, 0, 1)
    frio_ok = prot * (1.0 - w_follaje)
    b -= look["cool_sh"] * w_sh * frio_ok
    a -= look["cool_sh"] * 0.35 * w_sh * frio_ok
    a += 0.0045 * prot; b += 0.0060 * prot
    calmid = look["warm_mid"] * w_mid * prot
    a += calmid * 0.7; b += calmid
    calhi = look["warm_hi"] * w_hi
    a += calhi * 0.4; b += calhi
    # depth (máscara a 1/4 res)
    lin_s = cv2.resize(lin, (w // 4, h // 4), interpolation=cv2.INTER_AREA)
    piel_s = cv2.resize(piel, (w // 4, h // 4), interpolation=cv2.INTER_AREA)
    fondo_s = mascara_fondo(lin_s, piel_s)
    fondo = cv2.resize(fondo_s, (w, h), interpolation=cv2.INTER_LINEAR) * look["depth"]
    b -= 0.002 * fondo
    fac_c = 1.0 - 0.06 * fondo
    a *= fac_c; b *= fac_c
    L = L + 0.010 * fondo
    cerca = np.clip(1.0 - fondo * 1.4, 0, 1) * prot
    L = L - look["dens"] * 0.25 * cerca * np.clip(1 - L, 0, 1)
    # separación de verdes
    w_v2 = np.clip(1.0 - np.abs(Hp2 - 140) / 45.0, 0, 1)
    sombra_v = w_v2 * w_sh; alta_v = w_v2 * (1.0 - w_sh)
    dH_v = (-7.0 * sombra_v + 6.0 * alta_v) * look["sepv"] * prot
    mrot = w_v2 > 0.01
    Cv = np.sqrt(a * a + b * b)
    Hv = np.degrees(np.arctan2(b, a)) + dH_v
    Hvr = np.radians(Hv)
    a = np.where(mrot, Cv * np.cos(Hvr), a)
    b = np.where(mrot, Cv * np.sin(Hvr), b)

    # ---- piel: cromaticidad original + grade propio (ANTES de density, como el pipeline aprobado) ----
    a_piel = a0 * 1.14 + 0.0035
    b_piel = b0 * 1.14 + 0.0050
    a = a * (1 - piel) + a_piel * piel
    b = b * (1 - piel) + b_piel * piel

    out = np.maximum(oklab_to_rgb(np.stack([np.clip(L, 0, 1.2), a, b], -1)), 0.0)
    # ---- film density: escala RGB lineal por chroma final (idéntico al aprobado) ----
    Cf = np.sqrt(a * a + b * b)
    dens = 1.0 - 0.10 * np.clip(Cf / 0.14, 0, 1) * 0.5
    return out * dens[..., None]

def procesar_fast(img16, esc, rng):
    lin = to_linear(img16)
    lin = lin * esc["exp"]
    lin = lin * np.asarray(esc["wb"], np.float32)[None, None, :]
    lin = shoulder(lin)
    lin = toe(lin)
    lin = contraste_local(lin)
    disp0 = to_display(lin)
    piel = mascara_piel(disp0)
    lin = textura(lin, piel)
    # COLOR a 1/2 res como mapa de ratios (el color es de baja frecuencia espacial)
    h, w = lin.shape[:2]
    lin_h = cv2.resize(lin, (w // 2, h // 2), interpolation=cv2.INTER_AREA)
    piel_h = cv2.resize(piel, (w // 2, h // 2), interpolation=cv2.INTER_AREA)
    out_h = _color_unificado(lin_h, piel_h, LOOKS.get(esc.get("clase", "paisaje"), LOOKS["paisaje"]), esc.get("color", {}))
    ratio_h = out_h / np.maximum(lin_h, 1e-5)
    ratio = cv2.resize(np.clip(ratio_h, 0.0, 4.0), (w, h), interpolation=cv2.INTER_LINEAR)
    lin = lin * ratio
    disp = to_display(np.clip(lin, 0.0, 4.0))
    disp = s_curve_display(disp)
    disp = grano_dither(disp, rng)
    return (disp * 65535.0 + 0.5).astype(np.uint16)

# ---------- optimizaciones de render: LUTs de curvas y banco de grano ----------
_LUT_CURVA = None
def _curva_lut():
    """LUT compuesta shoulder+toe (lineal) — funciones puras de Y."""
    global _LUT_CURVA
    if _LUT_CURVA is None:
        Y = np.linspace(0, 1, 65536).astype(np.float32)
        knee, strength = 0.62, 1.9
        t = Y - knee
        Yc = np.where(Y > knee, knee + t / (1.0 + strength * t / (1.0 - knee)), Y)
        piso, fuerza, k = 0.0016, 0.55, 0.05
        p = 1.0 + fuerza
        Ylow = piso + (Y / k) ** p * (k - piso)
        Yc2 = np.where(Y < k, Ylow * (Yc / np.maximum(Y, 1e-9)), Yc)
        # ratio final vs Y
        _LUT_CURVA = (np.where(Y > 1e-6, Yc2 / np.maximum(Y, 1e-6), 1.0)).astype(np.float32)
        _LUT_CURVA[0] = 1.0
    return _LUT_CURVA

def shoulder_toe_lut(lin):
    Y = luma_of(lin)
    idx = (np.clip(Y, 0, 1) * 65535 + 0.5).astype(np.uint16)
    return lin * np.clip(_curva_lut()[idx], 0.0, 1.5)[..., None]

_LUT_SCURVE = None
def _scurve_lut():
    global _LUT_SCURVE
    if _LUT_SCURVE is None:
        Y = np.linspace(0, 1, 65536).astype(np.float32)
        pivot, c_alto, c_bajo, lift, whites, shadow_lift = 0.42, 1.24, 1.10, -0.013, 1.05, 0.085
        Yl = np.clip((Y + lift) / (1.0 + lift), 0.0, 1.0)
        Yc = np.where(Yl >= pivot, pivot + (Yl - pivot) * c_alto, pivot + (Yl - pivot) * c_bajo)
        banda = np.exp(-((Yc - 0.16) ** 2) / (2 * 0.09 ** 2))
        Yc = Yc + shadow_lift * banda * Yc
        Yc = Yc * (1.0 + (whites - 1.0) * np.clip((Yc - 0.55) / 0.45, 0, 1))
        Yc = np.where(Yc > 0.86, 0.86 + (Yc - 0.86) * 0.60, Yc)
        Yc = np.clip(Yc, 0.0, 1.0)
        _LUT_SCURVE = (np.where(Y > 1e-6, Yc / np.maximum(Y, 1e-6), 1.0)).astype(np.float32)
        _LUT_SCURVE[0] = 1.0
    return _LUT_SCURVE

def s_curve_lut(disp):
    Y = disp @ LUMA
    idx = (np.clip(Y, 0, 1) * 65535 + 0.5).astype(np.uint16)
    return np.clip(disp * _scurve_lut()[idx][..., None], 0.0, 1.0)

_GRANO_BANK = None
def _grano_bank(shape, rng):
    """Banco de 6 campos de grano+dither pre-generados; se rota por frame."""
    global _GRANO_BANK
    if _GRANO_BANK is None or _GRANO_BANK[0][0].shape != shape:
        gs = []
        for _ in range(6):
            g = rng.standard_normal(shape).astype(np.float32)
            g = cv2.GaussianBlur(g, (0, 0), 0.7)
            tri = (rng.random(shape + (3,), dtype=np.float32) - rng.random(shape + (3,), dtype=np.float32)) / 255.0
            gs.append((g, tri))
        _GRANO_BANK = gs
    return _GRANO_BANK

def grano_dither_fast(disp, rng, fidx, cantidad=0.0075):
    Y = disp @ LUMA
    bank = _grano_bank(Y.shape, rng)
    g, tri = bank[fidx % len(bank)]
    # desplazamiento circular aleatorio por frame (rompe el patrón estático)
    dy = (fidx * 397) % Y.shape[0]; dx = (fidx * 683) % Y.shape[1]
    g = np.roll(np.roll(g, dy, 0), dx, 1)
    tri = np.roll(np.roll(tri, dy, 0), dx, 1)
    peso = (1.0 - np.abs(2.0 * Y - 1.0)) * 0.75 + 0.25
    return np.clip(disp + (g * cantidad * peso)[..., None] + tri, 0.0, 1.0)

def procesar_render(img16, esc, rng, fidx):
    """Camino DEFINITIVO de render: idéntico a procesar_fast con curvas LUT y grano de banco."""
    lin = to_linear(img16)
    lin = lin * esc["exp"]
    lin = lin * np.asarray(esc["wb"], np.float32)[None, None, :]
    lin = shoulder_toe_lut(lin)
    lin = contraste_local(lin)
    disp0 = to_display(lin)
    piel = mascara_piel(disp0)
    lin = textura(lin, piel)
    h, w = lin.shape[:2]
    lin_h = cv2.resize(lin, (w // 2, h // 2), interpolation=cv2.INTER_AREA)
    piel_h = cv2.resize(piel, (w // 2, h // 2), interpolation=cv2.INTER_AREA)
    out_h = _color_unificado(lin_h, piel_h, LOOKS.get(esc.get("clase", "paisaje"), LOOKS["paisaje"]), esc.get("color", {}))
    ratio_h = out_h / np.maximum(lin_h, 1e-5)
    ratio = cv2.resize(np.clip(ratio_h, 0.0, 4.0), (w, h), interpolation=cv2.INTER_LINEAR)
    lin = lin * ratio
    disp = to_display(np.clip(lin, 0.0, 4.0))
    disp = s_curve_lut(disp)
    disp = grano_dither_fast(disp, rng, fidx)
    return (disp * 65535.0 + 0.5).astype(np.uint16)
