#!/usr/bin/env python3
"""MOTOR DE COLOR V3 — nivel colorista profesional (objetivo 9+/10).

Evolución del V2 (6.8-7.3/10) atacando la crítica punto por punto:
piel orgánica, density subtractiva, black anchor por escena, WB artístico,
amarillos→ámbar, espacio LOG para el trabajo tonal, log wheels por clase,
film matrix, Luma-vs-Sat, reconstrucción de highlights y SHOT MATCHING
(constancia de piel entre escenas anclada a un héroe aprobado).

REGLA DE ORO: UNA sola función canónica `procesar_v3(img16, esc, rng, fidx)`.
El visor A/B y el render de nube llaman EXACTAMENTE este código. No existen
variantes "rápidas" — las optimizaciones viven aquí dentro desde el día uno.

Entrada: frame uint16 RGB (gbrp/rgb48le de ffmpeg) del máster SIN color.
`esc` viene de mapa_params_v3.json (resuelto por analizar_escenas_v3.py):
  exp, wb[3], clase, black_src, skin_delta[2], sat_trim
Salida: uint16 RGB listo para el encoder. ffmpeg SOLO decodifica/encodea.
"""
import numpy as np, cv2, subprocess, json, os, sys

FF = os.environ.get("FF", "/tmp/ffbin/ffmpeg")
cv2.setNumThreads(int(os.environ.get("CV_THREADS", "1")))

# ============================== TRANSFERENCIAS ==============================
_x16 = np.linspace(0.0, 1.0, 65536).astype(np.float32)
_LUT_LIN = np.power(_x16, 2.4).astype(np.float32)                 # BT.1886
_LUT_DISP = np.power(np.maximum(_x16, 1e-9), 1.0 / 2.4).astype(np.float32)

def to_linear(img16):
    return _LUT_LIN[img16]

def to_display(lin):
    idx = (np.clip(lin, 0.0, 1.0) * 65535.0 + 0.5).astype(np.uint16)
    return _LUT_DISP[idx]

# LOG tipo ACEScct: trabajo tonal con rolloff orgánico (no lineal ni display)
_A, _B = 10.5402377416545, 0.0729055341958355   # segmento lineal cct
def lin_to_log(x):
    x = np.maximum(x, 0.0)
    lo = _A * x + _B
    hi = (np.log2(np.maximum(x, 1e-7)) + 9.72) / 17.52
    return np.where(x <= 0.0078125, lo, hi).astype(np.float32)

def log_to_lin(y):
    lo = (y - _B) / _A
    hi = np.exp2(y * 17.52 - 9.72)
    return np.where(y <= _A * 0.0078125 + _B, lo, hi).astype(np.float32)

# ============================== OKLAB ==============================
_M1 = np.array([[0.4122214708, 0.5363325363, 0.0514459929],
                [0.2119034982, 0.6806995451, 0.1073969566],
                [0.0883024619, 0.2817188376, 0.6299787005]], np.float32)
_M2 = np.array([[0.2104542553, 0.7936177850, -0.0040720468],
                [1.9779984951, -2.4285922050, 0.4505937099],
                [0.0259040371, 0.7827717662, -0.8086757660]], np.float32)
_M1i = np.linalg.inv(_M1).astype(np.float32)
_M2i = np.linalg.inv(_M2).astype(np.float32)

def rgb_to_oklab(lin):
    lms = np.cbrt(np.maximum(lin @ _M1.T, 0.0))
    return lms @ _M2.T

def oklab_to_rgb(lab):
    lms = lab @ _M2i.T
    return (lms * lms * lms) @ _M1i.T

LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)

def smoothstep(x, e0, e1):
    t = np.clip((x - e0) / (e1 - e0 + 1e-9), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)

def campana(H, h0, ancho, dureza=1.5):
    d = np.abs(((H - h0 + 180.0) % 360.0) - 180.0)
    return np.clip(1.0 - d / ancho, 0.0, 1.0) ** dureza

# ============================== QUALIFIERS ==============================
def mascara_piel(disp):
    """Qualifier de piel calibrado con datos del material (cara real Cr~137, Cb~120)."""
    bgr = (np.clip(disp[..., ::-1], 0, 1) * 255).astype(np.uint8)
    ycc = cv2.cvtColor(bgr, cv2.COLOR_BGR2YCrCb).astype(np.float32)
    Y, Cr, Cb = ycc[..., 0] / 255.0, ycc[..., 1], ycc[..., 2]
    cr = np.clip((Cr - 130.0) / 5.5, 0.0, 1.0)
    cb = np.exp(-((Cb - 120.0) ** 2) / (2 * 13.0 ** 2))
    yg = np.clip((Y - 0.09) / 0.07, 0, 1) * np.clip((0.86 - Y) / 0.10, 0, 1)
    m = cv2.GaussianBlur(cr * cb * yg, (0, 0), 6)
    return np.clip(m * 1.4, 0.0, 1.0)

def mascara_fondo(lin_s, piel_s):
    """Proxy de profundidad (1/4 res): lejos = brillo + baja sat + poco detalle + arriba."""
    Y = lin_s @ LUMA
    h, w = Y.shape
    det = np.abs(Y - cv2.GaussianBlur(Y, (0, 0), 4))
    det_n = cv2.GaussianBlur(det, (0, 0), 25)
    det_n = det_n / (det_n.max() + 1e-6)
    mx = lin_s.max(2); mn = lin_s.min(2)
    sat = (mx - mn) / np.maximum(mx, 1e-6)
    haze = np.clip(Y * 1.6, 0, 1) * np.clip(1.0 - sat * 2.2, 0, 1)
    vert = np.linspace(1.0, 0.25, h, dtype=np.float32)[:, None] * np.ones((1, w), np.float32)
    fondo = np.clip(0.45 * (1.0 - det_n) + 0.30 * haze + 0.25 * vert, 0, 1)
    return np.clip(cv2.GaussianBlur(fondo, (0, 0), 30) * (1.0 - piel_s), 0, 1)

# ============================== LOOKS POR CLASE ==============================
# wb_art: sesgo artístico [R,G,B] encima del neutro técnico (la "emoción", no el gris)
# wheels: (sombras[a,b], medios[a,b], altas[a,b]) offsets Oklab en espacio LOG-tonal
# dens: fuerza de density subtractiva | contraste: (c_alto, c_bajo) | pivot
LOOKS = {
    "retrato":  dict(wb_art=[1.011, 1.0, 0.984], dens=0.16, contraste=(1.26, 1.13), pivot=0.43,
                     wheels=([-0.004, -0.002], [0.005, 0.007], [0.002, 0.0035]), sepv=0.5, depth=0.9),
    "agua":     dict(wb_art=[1.004, 1.0, 0.996], dens=0.14, contraste=(1.26, 1.12), pivot=0.44,
                     wheels=([-0.006, -0.005], [0.002, 0.003], [0.0015, 0.0025]), sepv=0.4, depth=1.0),
    "cascada":  dict(wb_art=[1.005, 1.0, 0.994], dens=0.12, contraste=(1.24, 1.10), pivot=0.45,
                     wheels=([-0.005, -0.004], [0.002, 0.003], [0.002, 0.003]), sepv=0.3, depth=0.7),
    "bosque":   dict(wb_art=[1.010, 1.0, 0.986], dens=0.17, contraste=(1.27, 1.13), pivot=0.42,
                     wheels=([-0.004, -0.003], [0.005, 0.006], [0.0025, 0.004]), sepv=1.0, depth=1.0),
    "terrazas": dict(wb_art=[1.009, 1.0, 0.988], dens=0.15, contraste=(1.25, 1.12), pivot=0.44,
                     wheels=([-0.003, -0.002], [0.005, 0.006], [0.0025, 0.004]), sepv=0.4, depth=0.8),
    "trading":  dict(wb_art=[1.006, 1.0, 0.992], dens=0.13, contraste=(1.24, 1.11), pivot=0.42,
                     wheels=([-0.004, -0.003], [0.003, 0.004], [0.0015, 0.0025]), sepv=0.3, depth=0.5),
    "paisaje":  dict(wb_art=[1.008, 1.0, 0.989], dens=0.15, contraste=(1.26, 1.12), pivot=0.43,
                     wheels=([-0.005, -0.004], [0.004, 0.005], [0.002, 0.0035]), sepv=0.7, depth=1.0),
}

# FILM MATRIX: acople suave entre canales (fuera de piel) — separa el color como print
_FILM_M = np.array([[1.06, -0.04, -0.02],
                    [-0.03, 1.05, -0.02],
                    [-0.02, -0.05, 1.07]], np.float32)

# ============================== ETAPAS ==============================
def reconstruir_highlights(lin):
    """Restaura chroma en altas (0.78-0.97): la cámara lo mata; se rehidrata del entorno."""
    Y = lin @ LUMA
    w = smoothstep(Y, 0.78, 0.90) * (1.0 - smoothstep(Y, 0.94, 0.99))
    if float(w.max()) < 0.02:
        return lin
    ratio = lin / np.maximum(Y[..., None], 1e-6)
    h, ww = Y.shape
    r_s = cv2.resize(ratio, (ww // 4, h // 4), interpolation=cv2.INTER_AREA)
    r_blur = cv2.GaussianBlur(r_s, (0, 0), 12)
    r_env = cv2.resize(r_blur, (ww, h), interpolation=cv2.INTER_LINEAR)
    # SOLO-RECUPERACIÓN: mezclar hacia el entorno únicamente donde el entorno tiene
    # MÁS color que el píxel (highlight muerto). Nunca robar color a highlights vivos
    # (lección: las lagunas turquesa de Huanglong quedaban blancas).
    sat_px = ratio.max(2) - ratio.min(2)
    sat_env = r_env.max(2) - r_env.min(2)
    recupera = np.clip((sat_env - sat_px) / 0.10, 0.0, 1.0)
    ratio_mix = ratio + (r_env - ratio) * (w * 0.55 * recupera)[..., None]
    return np.clip(ratio_mix * Y[..., None], 0.0, 4.0)

def shoulder_lineal(lin, knee=0.60, strength=2.0):
    Y = lin @ LUMA
    t = Y - knee
    Yc = np.where(Y > knee, knee + t / (1.0 + strength * t / (1.0 - knee)), Y)
    r = np.where(Y > 1e-6, Yc / np.maximum(Y, 1e-6), 1.0)
    return lin * r[..., None]

def tonal_log(lin, look, black_src, piel, anchor_k=1.0):
    """Trabajo tonal EN LOG: black anchor por escena, contraste asimétrico con pivot,
    log wheels por clase, density de medios. Rolloff orgánico garantizado por el espacio."""
    Y = np.maximum(lin @ LUMA, 0.0)
    Lg = lin_to_log(Y)

    # --- BLACK ANCHOR por escena: p0.5 medido (black_src, en log) -> piso objetivo ---
    target_floor = lin_to_log(np.float32(0.0035))     # negro rico con textura (display ~0.10)
    src = np.float32(max(black_src, 1e-4))
    src_log = lin_to_log(src)
    # compresión de pedestal: debajo del ancla todo baja proporcionalmente, con toe suave
    delta_black = np.float32(src_log - target_floor)
    w_sh_anchor = np.clip(1.0 - smoothstep(Lg, src_log, src_log + 0.22), 0.0, 1.0)
    Lg = Lg - delta_black * w_sh_anchor * 0.85 * np.float32(anchor_k)

    # --- contraste asimétrico alrededor del pivot (en log) ---
    c_alto, c_bajo = look["contraste"]
    pv = lin_to_log(np.float32(look["pivot"] ** 2.4))  # pivot dado en display -> lineal -> log
    Lg = np.where(Lg >= pv, pv + (Lg - pv) * c_alto, pv + (Lg - pv) * c_bajo)
    # shoulder alto en LOG: el contraste no empuja las altas al techo blanco
    ksh = lin_to_log(np.float32(0.62))
    Lg = np.where(Lg > ksh, ksh + (Lg - ksh) * 0.72, Lg)

    # --- density de medios: gamma sutil que da PESO (los medios bajan, textura intacta) ---
    w_mid = np.exp(-((Lg - pv) ** 2) / (2 * 0.16 ** 2))
    Lg = Lg - 0.030 * w_mid * look["dens"] / 0.15

    Y2 = np.maximum(log_to_lin(np.clip(Lg, 0.0, 1.2)), 0.0)
    r = np.where(Y > 1e-6, Y2 / np.maximum(Y, 1e-6), 1.0)
    out = lin * np.clip(r, 0.0, 8.0)[..., None]

    # --- LOG WHEELS: offsets de color por banda tonal (la decisión artística) ---
    w_sh = np.clip(1.0 - smoothstep(Lg, 0.18, 0.42), 0, 1)
    w_hi = smoothstep(Lg, 0.55, 0.78)
    w_md = np.clip(1.0 - w_sh - w_hi, 0, 1)
    sh, md, hi = look["wheels"]
    prot = (1.0 - piel)
    lab = rgb_to_oklab(np.maximum(out, 0.0))
    lab[..., 1] += (sh[0] * w_sh + md[0] * w_md + hi[0] * w_hi) * prot
    lab[..., 2] += (sh[1] * w_sh + md[1] * w_md + hi[1] * w_hi) * prot
    return np.maximum(oklab_to_rgb(lab), 0.0)

def contraste_local(lin, piel, gain_base=0.22, gain_det=0.09):
    """Edge-aware (bilateral 1/6) sin halos; la piel recibe MENOS (organicidad)."""
    Y = np.maximum(lin @ LUMA, 1e-6)
    L = np.log2(Y)
    h, w = L.shape
    small = cv2.resize(L, (w // 6, h // 6), interpolation=cv2.INTER_AREA)
    base_s = cv2.bilateralFilter(small, d=17, sigmaColor=0.55, sigmaSpace=13)
    base = cv2.resize(base_s, (w, h), interpolation=cv2.INTER_LINEAR)
    det_g = np.clip(L - base, -1.2, 1.2)
    fino = cv2.GaussianBlur(L, (0, 0), 6)
    det_m = np.clip(L - fino, -0.6, 0.6)
    atten = 1.0 - 0.65 * piel                       # piel: 35% del efecto
    delta = (det_g * gain_base + det_m * gain_det) * atten
    protege = np.clip((Y - 0.008) / 0.03, 0.15, 1.0)
    delta = np.where(delta < 0, delta * protege, delta)
    return lin * np.exp2(np.clip(delta, -0.7, 0.7))[..., None]

def piel_organica(lin, piel):
    """El fix de 'piel digital': microcontraste reducido, speculares cremosos,
    variación tonal sutil (no uniforme). Solo bajo la máscara."""
    if float(piel.max()) < 0.05:
        return lin
    Y = lin @ LUMA
    # microcontraste: -40% del detalle fino bajo piel (poros/aspereza -> suavidad de print)
    det = Y - cv2.GaussianBlur(Y, (0, 0), 2.2)
    Y2 = Y - det * 0.40 * piel
    # speculares cremosos: rolloff extra del brillo de piel (frente/nariz)
    spec = smoothstep(Y2, 0.55, 0.80)
    Y2 = Y2 - (Y2 - 0.55) * 0.22 * spec * piel
    r = np.where(Y > 1e-6, Y2 / np.maximum(Y, 1e-6), 1.0)
    return lin * np.clip(r, 0.3, 2.0)[..., None]

def color_creativo(lin, piel, look, esc):
    """Color en Oklab: agua turquesa aprobada, verdes separados, YELLOWS->ámbar,
    Luma-vs-Sat, film matrix, depth, vibrance anti-neón, density por chroma,
    y PIEL: cromaticidad propia + shot-matching delta + variación orgánica."""
    lab = rgb_to_oklab(np.maximum(lin, 0.0))
    L = lab[..., 0].copy()
    a0 = lab[..., 1].copy(); b0 = lab[..., 2].copy()
    a = a0.copy(); b = b0.copy()
    C = np.sqrt(a * a + b * b)
    H = np.degrees(np.arctan2(b, a)); H = np.where(H < 0, H + 360, H)
    prot = 1.0 - piel
    h, w = L.shape

    # --- AGUA (aprobado V2): banda asimétrica anti-vegetación, +8° hacia azul, vívida ---
    Yl = lin @ LUMA
    Ys = cv2.resize(Yl, (w // 2, h // 2), interpolation=cv2.INTER_AREA)
    det_s = np.abs(Ys - cv2.GaussianBlur(Ys, (0, 0), 1.25))
    det_n = cv2.resize(cv2.GaussianBlur(det_s, (0, 0), 6), (w, h), interpolation=cv2.INTER_LINEAR)
    tex_pen = np.clip(1.0 - det_n / 0.05, 0.3, 1.0)
    a_low = np.float32(esc.get("agua_low", 150.0))
    a_gain = np.float32(esc.get("agua_gain", 1.0))
    banda = smoothstep(H, a_low, a_low + 14) * (1.0 - smoothstep(H, 212, 242))
    solape = smoothstep(H, a_low, a_low + 10) * (1.0 - smoothstep(H, a_low + 12, a_low + 22))
    c_gate = np.float32(esc.get("agua_cgate", 0.045))
    w_agua = banda * np.clip(C / c_gate, 0, 1) * (1.0 - solape * (1.0 - tex_pen)) * prot
    # con banda extendida, la vegetación se excluye SIEMPRE por textura (no solo el solape)
    if a_low < 149.0:
        w_agua = w_agua * (0.25 + 0.75 * tex_pen)
    w_verde = campana(H, 135, 38) * prot
    # --- YELLOWS -> ÁMBAR/MIEL (la madera con masa): banda 88-118, NO toca verdes ---
    piel_dil = cv2.GaussianBlur(piel, (0, 0), 18)
    w_yellow = campana(H, 85, 12, dureza=1.6) * prot * (1.0 - w_verde) * np.clip(1.0 - piel_dil * 2.5, 0.0, 1.0)

    exceso = np.clip((C - 0.115) / 0.05, 0, 1)
    # agua_dh: rotación EXTRA hacia azul (default 0 = idéntico al look aprobado)
    dH = (8.0 + 6.0 * (a_gain - 1.0) + np.float32(esc.get("agua_dh", 0.0))) * w_agua + 1.5 * w_verde - 10.0 * w_yellow
    dC = 0.05 * w_verde * C + w_agua * C * (0.34 * a_gain - 0.30 * exceso) - 0.06 * w_yellow * C
    dL = 0.022 * a_gain * w_agua - 0.020 * w_yellow

    # vibrance anti-neón (chroma bajo sube, alto no)
    vib = 0.12 * np.clip(1.0 - C / 0.13, 0.0, 1.0) * prot
    dC = dC + C * vib

    Hn = np.radians(H + dH)
    Cn = np.maximum(C + dC, 0.0)
    L = np.clip(L + dL, 0.0, 1.2)
    a = Cn * np.cos(Hn); b = Cn * np.sin(Hn)

    # --- calidez global + separación de verdes (sombra->esmeralda, luz->lima) ---
    a += 0.0022 * prot; b += 0.0030 * prot
    w_sh = np.clip(1.0 - L / 0.42, 0, 1) ** 1.4
    w_v2 = np.clip(1.0 - np.abs(H - 140) / 45.0, 0, 1)
    dH_v = (-7.0 * w_v2 * w_sh + 6.0 * w_v2 * (1.0 - w_sh)) * look["sepv"] * prot
    mrot = w_v2 > 0.01
    Cv = np.sqrt(a * a + b * b)
    Hv = np.radians(np.degrees(np.arctan2(b, a)) + dH_v)
    a = np.where(mrot, Cv * np.cos(Hv), a)
    b = np.where(mrot, Cv * np.sin(Hv), b)

    # --- DEPTH coloring (1/4 res) ---
    lin_s = cv2.resize(lin, (w // 4, h // 4), interpolation=cv2.INTER_AREA)
    piel_s = cv2.resize(piel, (w // 4, h // 4), interpolation=cv2.INTER_AREA)
    fondo = cv2.resize(mascara_fondo(lin_s, piel_s), (w, h), interpolation=cv2.INTER_LINEAR) * look["depth"]
    b -= 0.002 * fondo
    fc = 1.0 - 0.06 * fondo
    a *= fc; b *= fc
    L = L + 0.010 * fondo
    cerca = np.clip(1.0 - fondo * 1.4, 0, 1) * prot
    L = L - 0.05 * 0.25 * cerca * np.clip(1 - L, 0, 1)

    # --- DENSITY de highlights coloreados: brillo alto + chroma -> baja luma (el color respira) ---
    Chl = np.sqrt(a * a + b * b)
    w_hl = smoothstep(L, 0.80, 0.93) * np.clip(Chl / 0.035, 0, 1)
    L = L - 0.075 * w_hl

    # --- LUMA vs SAT (print): sombras profundas desaturan; en altas SOLO los neutros
    # (las lagunas turquesa brillantes CONSERVAN su color — lección escena 16) ---
    Cnow = np.sqrt(a * a + b * b)
    neutralidad = np.clip(1.0 - Cnow / 0.045, 0.0, 1.0)
    lvs = (1.0 - 0.35 * np.clip(1.0 - L / 0.12, 0, 1))         * (1.0 - 0.22 * smoothstep(L, 0.90, 0.995) * (0.35 + 0.65 * neutralidad))
    a *= lvs; b *= lvs

    # --- sat_trim del shot matching (chroma p90 alineado a la clase) ---
    st = np.float32(esc.get("sat_trim", 1.0))
    a *= st; b *= st

    # --- PIEL: cromaticidad original + grade propio + SHOT MATCHING + variación orgánica ---
    sd = esc.get("skin_delta", [0.0, 0.0])
    # variación sutil por banda de luma (mejillas/medios ligeramente más cálidos que frente/altas)
    var = np.exp(-((L - 0.52) ** 2) / (2 * 0.13 ** 2)) * 0.06
    swk = np.float32(esc.get("skin_warm", 1.0))
    a_p = a0 * (1.16 + var) + 0.0050 * swk + np.float32(sd[0])
    b_p = b0 * (1.16 + var) + 0.0068 * swk + np.float32(sd[1])
    a = a * prot + a_p * piel
    b = b * prot + b_p * piel

    out = np.maximum(oklab_to_rgb(np.stack([np.clip(L, 0, 1.2), a, b], -1)), 0.0)

    # --- FILM MATRIX (separación de color tipo print) fuera de piel ---
    out_fm = np.maximum(out @ _FILM_M.T, 0.0)
    out = out + (out_fm - out) * (prot * 0.55)[..., None]

    # --- FILM DENSITY subtractiva (el peso): el chroma OSCURECE, sobre todo medios ---
    Cf = np.sqrt(a * a + b * b)
    w_mid = np.exp(-((L - 0.50) ** 2) / (2 * 0.22 ** 2))
    dens = 1.0 - look["dens"] * np.float32(esc.get("dens_k", 1.0)) * np.clip(Cf / 0.13, 0, 1) * (0.35 + 0.65 * w_mid)
    return out * np.clip(dens, 0.6, 1.0)[..., None]

def halation(disp, fuerza=0.055):
    """Halation/bloom de película: las altas sangran un resplandor cálido suave.
    Doble escala (radio corto intenso + largo tenue), tinte ámbar como print real."""
    Y = disp @ LUMA
    hi = np.clip((Y - 0.72) / 0.28, 0.0, 1.0) ** 1.5
    if float(hi.max()) < 0.02:
        return disp
    h, w = Y.shape
    src = (hi * Y).astype(np.float32)
    s4 = cv2.resize(src, (w // 4, h // 4), interpolation=cv2.INTER_AREA)
    g1 = cv2.resize(cv2.GaussianBlur(s4, (0, 0), 3), (w, h), interpolation=cv2.INTER_LINEAR)
    g2 = cv2.resize(cv2.GaussianBlur(s4, (0, 0), 11), (w, h), interpolation=cv2.INTER_LINEAR)
    glow = (g1 * 0.65 + g2 * 0.35) * fuerza
    # tinte del halo: cálido (r>g>b) como halación de emulsión
    out = disp.copy()
    out[..., 0] = out[..., 0] + glow * 1.00
    out[..., 1] = out[..., 1] + glow * 0.62
    out[..., 2] = out[..., 2] + glow * 0.38
    return np.clip(out, 0.0, 1.0)

def print_curve(disp, look):
    """Curva de PRINT display-referred: toe profundo, shoulder limpio, whites vivos."""
    Y = disp @ LUMA
    Yl = np.clip((Y - 0.006) / 0.994, 0.0, 1.0)               # blacks -0.6% extra
    pv = look["pivot"]
    Yc = np.where(Yl >= pv, pv + (Yl - pv) * 1.06, pv + (Yl - pv) * 1.02)
    banda = np.exp(-((Yc - 0.15) ** 2) / (2 * 0.085 ** 2))    # sombras respiran
    Yc = Yc + 0.055 * banda * Yc
    mx = disp.max(2); mn = disp.min(2)
    satd = (mx - mn) / np.maximum(mx, 1e-6)
    neut = np.clip(1.0 - satd * 3.0, 0.0, 1.0)
    Yc = Yc * (1.0 + 0.05 * np.clip((Yc - 0.55) / 0.45, 0, 1) * (0.3 + 0.7 * neut))
    Yc = np.where(Yc > 0.87, 0.87 + (Yc - 0.87) * 0.58, Yc)
    Yc = np.clip(Yc, 0.0, 1.0)
    r = np.where(Y > 1e-6, Yc / np.maximum(Y, 1e-6), 1.0)
    return np.clip(disp * r[..., None], 0.0, 1.0)

# grano de banco (probado en V2): fino, dependiente de luma, dither triangular
_BANK = None
def _grano_bank(shape):
    global _BANK
    if _BANK is None or _BANK[0][0].shape != shape:
        rng = np.random.default_rng(7)
        gs = []
        for _ in range(6):
            g = cv2.GaussianBlur(rng.standard_normal(shape).astype(np.float32), (0, 0), 0.7)
            tri = (rng.random(shape + (3,), dtype=np.float32) - rng.random(shape + (3,), dtype=np.float32)) / 255.0
            gs.append((g, tri))
        _BANK = gs
    return _BANK

def grano_dither(disp, fidx, cantidad=0.0085):
    """Grano de emulsión: base común (correlación) + componente por canal (r/g/b
    con granos ligeramente distintos, como las tres capas de la película)."""
    Y = disp @ LUMA
    bank = _grano_bank(Y.shape)
    g, tri = bank[fidx % 6]
    g2, _ = bank[(fidx + 2) % 6]
    g3, _ = bank[(fidx + 4) % 6]
    dy = (fidx * 397) % Y.shape[0]; dx = (fidx * 683) % Y.shape[1]
    g = np.roll(np.roll(g, dy, 0), dx, 1)
    g2 = np.roll(np.roll(g2, dy // 2 + 31, 0), dx // 2 + 57, 1)
    g3 = np.roll(np.roll(g3, dy // 3 + 83, 0), dx // 3 + 19, 1)
    tri = np.roll(np.roll(tri, dy, 0), dx, 1)
    peso = ((1.0 - np.abs(2.0 * Y - 1.0)) * 0.7 + 0.3 + 0.25 * np.clip(1.0 - Y / 0.25, 0, 1)) * cantidad
    ruido = np.empty(disp.shape, np.float32)
    ruido[..., 0] = (g * 0.72 + g2 * 0.28) * peso
    ruido[..., 1] = (g * 0.80 + g3 * 0.20) * peso * 0.9
    ruido[..., 2] = (g * 0.62 + g2 * 0.22 + g3 * 0.16) * peso * 1.15
    return np.clip(disp + ruido + tri, 0.0, 1.0)

# ============================== PIPELINE CANÓNICO ==============================
def procesar_v3(img16, esc, fidx=0):
    """LA función. Visor y render llaman esto, byte a byte lo mismo."""
    look = LOOKS.get(esc.get("clase", "paisaje"), LOOKS["paisaje"])
    lin = to_linear(img16)
    lin = lin * np.float32(esc["exp"])
    wb = np.asarray(esc["wb"], np.float32) * np.asarray(look["wb_art"], np.float32)
    lin = lin * wb[None, None, :]
    lin = reconstruir_highlights(lin)
    lin = shoulder_lineal(lin)
    disp0 = to_display(lin)
    piel = mascara_piel(disp0)
    lin = tonal_log(lin, look, esc.get("black_src", 0.004), piel, esc.get("anchor_k", 1.0))
    lin = contraste_local(lin, piel)
    lin = piel_organica(lin, piel)
    lin = color_creativo(lin, piel, look, esc)
    lin = np.nan_to_num(lin, nan=0.0, posinf=4.0, neginf=0.0)
    disp = to_display(np.clip(lin, 0.0, 4.0))
    disp = halation(disp)
    disp = print_curve(disp, look)
    disp = grano_dither(disp, fidx)
    return (disp * 65535.0 + 0.5).astype(np.uint16)

# ============================== IO ==============================
def leer_frame(video, t, w=3840):
    r = subprocess.run([FF, "-nostdin", "-hide_banner", "-loglevel", "error",
                        "-ss", str(t), "-i", video, "-vframes", "1",
                        "-vf", f"scale={w}:-2", "-pix_fmt", "rgb48le", "-f", "rawvideo", "-"],
                       capture_output=True)
    n = len(r.stdout) // (w * 6)
    return np.frombuffer(r.stdout[: n * w * 6], np.uint16).reshape(n, w, 3).copy()

def guardar_jpg(img16, ruta, calidad=93):
    bgr8 = (img16[..., ::-1].astype(np.float32) / 257.0 + 0.5).astype(np.uint8)
    cv2.imwrite(ruta, bgr8, [cv2.IMWRITE_JPEG_QUALITY, calidad])

# ============================== SCOPES (validación real) ==============================
def vectorscope(img16, size=256):
    """Vectorscope Oklab (a,b) con skin line — para QC, no para adivinar."""
    lin = to_linear(img16[::4, ::4])
    lab = rgb_to_oklab(np.maximum(lin, 0.0))
    a = np.clip((lab[..., 1] / 0.18 + 1) * size / 2, 0, size - 1).astype(np.int32)
    b = np.clip((lab[..., 2] / 0.18 + 1) * size / 2, 0, size - 1).astype(np.int32)
    hist = np.zeros((size, size), np.float32)
    np.add.at(hist, (size - 1 - b.ravel(), a.ravel()), 1.0)
    img = np.clip(np.log1p(hist) / np.log1p(hist.max() + 1) * 255, 0, 255).astype(np.uint8)
    img = cv2.applyColorMap(img, cv2.COLORMAP_INFERNO)
    # skin line: hue de piel hero (~40° Oklab)
    cx, cy = size // 2, size // 2
    x2 = int(cx + np.cos(np.radians(67)) * size * 0.48)
    y2 = int(cy - np.sin(np.radians(67)) * size * 0.48)
    cv2.line(img, (cx, cy), (x2, y2), (0, 255, 0), 1)
    return img

def stats_frame(img16, piel=None):
    """Estadísticas de QC: piso, clip, chroma p90, piel (hue/sat medios)."""
    lin = to_linear(img16[::4, ::4])
    Y = lin @ LUMA
    disp = to_display(lin)
    Yd = disp @ LUMA
    lab = rgb_to_oklab(np.maximum(lin, 0.0))
    C = np.sqrt(lab[..., 1] ** 2 + lab[..., 2] ** 2)
    out = {
        "floor_d": float(np.percentile(Yd, 0.5)),
        "clip_pct": float((Yd > 0.985).mean() * 100),
        "c90": float(np.percentile(C, 90)),
    }
    if piel is None:
        piel = mascara_piel(disp)
    m = piel > 0.6
    if m.sum() > 300:
        am = float(lab[..., 1][m].mean()); bm = float(lab[..., 2][m].mean())
        out["skin_hue"] = float(np.degrees(np.arctan2(bm, am)) % 360)
        out["skin_sat"] = float(np.hypot(am, bm))
        out["skin_L"] = float(lab[..., 0][m].mean())
    return out

if __name__ == "__main__":
    # self-test: procesa un frame sintético y verifica invariantes
    rng = np.random.default_rng(0)
    img = (rng.random((270, 480, 3)) * 65535).astype(np.uint16)
    esc = {"exp": 1.0, "wb": [1, 1, 1], "clase": "paisaje", "black_src": 0.004,
           "skin_delta": [0, 0], "sat_trim": 1.0}
    out = procesar_v3(img, esc, 0)
    assert out.dtype == np.uint16 and out.shape == img.shape
    assert not np.isnan(out.astype(np.float64)).any()
    lg = lin_to_log(np.array([0.0, 0.001, 0.01, 0.18, 1.0], np.float32))
    rt = log_to_lin(lg)
    assert np.allclose(rt, [0.0, 0.001, 0.01, 0.18, 1.0], atol=1e-4), rt
    print("SELF-TEST OK (invariantes, log roundtrip)")
