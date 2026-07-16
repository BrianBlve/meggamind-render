import {
  AbsoluteFill,
  Audio,
  Easing,
  getRemotionEnvironment,
  interpolate,
  OffthreadVideo,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  Video,
} from "remotion";

// Reel vertical dirigido por reel_plan.json (la RECETA — nada horneado sin receta).
// Canvas 1080×1920; el 4K sale con `--scale=2`. Fuente SIEMPRE SDR bt709 (decisión B).
// Audio: SIEMPRE el del spine de piezas (sin offsets). Los overlays solo tapan el video.
// Lenguaje de paneles: 4:5 sobre fondo de marca, entrada/salida slide-up+scale+fade.

export type Reframe = {
  cx: number; cy?: number; zoom: number; cxTo?: number; zoomTo?: number;
  fit?: boolean; enter?: boolean; exit?: boolean; cxKf?: [number, number][];
};
export type Visual = { src: string; in: number };
export type Pieza = {
  src: string; clip: string; bloque: string; at: number; dur: number;
  atF?: number; durF?: number; reframe: Reframe; visual?: Visual; titulo?: string;
};
export type Overlay = {
  tipo: string; at: number; dur: number; in: number;
  pip?: boolean; titulo?: string; srcZoom?: number; srcY?: number;
  alpha?: boolean; palabras?: Record<string, number>;
  blurs?: { x: number; y: number; w: number; h: number; desde?: number }[];
};
export type Sub = { text: string; startMs: number; endMs: number; keyword?: string };
export type Evento = { tipo: "punch" | "glide" | "impacto"; at: number };
export type Plan = {
  fps: number; modo: "proxy" | "4k"; total: number; frames: number;
  piezas: Pieza[]; overlays: Overlay[]; subs?: Sub[]; eventos?: Evento[];
};
export type ReelProps = { plan: Plan | null; forceVideoTag?: boolean };

let FORCE_VIDEO_TAG = false;

export const calcReel = async ({ props }: { props: ReelProps }) => {
  const plan: Plan = props.plan ?? (await fetch(staticFile("reel_plan.json")).then((r) => r.json()));
  if (!plan.subs) {
    plan.subs = await fetch(staticFile("subs.json")).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  }
  FORCE_VIDEO_TAG = !!props.forceVideoTag;
  return { durationInFrames: Math.max(60, plan.frames), fps: plan.fps, props: { ...props, plan } };
};

const SRC_W = 3840;
const SRC_H = 2160;
const BG = "#05070A";
const CIAN = "#00E5FF";
const ANIM_F = 18; // 0.3s @60fps — entrada/salida elegante unificada

const Media: React.FC<{ src: string; muted?: boolean; style?: React.CSSProperties; trimBefore?: number; transparent?: boolean }> = (p) => {
  const C = getRemotionEnvironment().isRendering && !FORCE_VIDEO_TAG ? OffthreadVideo : Video;
  // transparent: OBLIGATORIO para webm con alpha en render (OffthreadVideo lo dibuja OPACO
  // sin este prop y tapa el texto detrás de la cabeza — bug del primer render 4K).
  return <C src={p.src} muted={p.muted} style={p.style} toneMapped={false} trimBefore={p.trimBefore} pauseWhenBuffering transparent={p.transparent} />;
};

// entrada/salida elegante: slide-up + escala 0.96→1 + fade (y la inversa al salir)
function animPanel(frame: number, durF: number, conEntrada: boolean, conSalida: boolean) {
  const e = conEntrada
    ? interpolate(frame, [0, ANIM_F], [0, 1], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) })
    : 1;
  const s = conSalida
    ? interpolate(frame, [durF - ANIM_F, durF], [1, 0], { extrapolateLeft: "clamp", easing: Easing.in(Easing.cubic) })
    : 1;
  const p = Math.min(e, s);
  return { opacity: p, transform: `translateY(${(1 - p) * 56}px) scale(${0.96 + 0.04 * p})` };
}

// entrada/salida propia de los chips: entran 6 frames después del panel (escalonado, notorio)
function animChip(frame: number, durF: number, conEntrada: boolean, conSalida: boolean) {
  const e = conEntrada
    ? interpolate(frame, [6, 33], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) })
    : 1;
  const s = conSalida
    ? interpolate(frame, [durF - 24, durF - 8], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.in(Easing.cubic) })
    : 1;
  const p = Math.min(e, s);
  return { p, opacity: p, transform: `translateX(${(1 - p) * -60}px)` };
}

// la barrita cian del chip crece al entrar
const BarraChip: React.FC<{ h: number; p: number }> = ({ h, p }) => (
  <div style={{ width: 6, height: h, background: CIAN, borderRadius: 3, transform: `scaleY(${p})`, transformOrigin: "bottom" }} />
);

const GlowMarca: React.FC<{ top: number; height: number }> = ({ top, height }) => (
  <div
    style={{
      position: "absolute", left: -240, top, width: 1560, height,
      background: "radial-gradient(closest-side, rgba(0,229,255,0.08), rgba(0,229,255,0))",
    }}
  />
);

// punch-in de palabra clave DENTRO del encuadre (el marco no se mueve jamás)
function punchInterno(frameAbs: number, fps: number, eventos: Evento[]) {
  let z = 1;
  for (const e of eventos) {
    if (e.tipo !== "punch") continue;
    const f0 = Math.round(e.at * fps);
    if (frameAbs >= f0 && frameAbs <= f0 + 34) {
      z = Math.max(z, interpolate(frameAbs, [f0, f0 + 1, f0 + 34], [1.0, 1.13, 1.0], {
        extrapolateRight: "clamp", easing: Easing.out(Easing.cubic),
      }));
    }
  }
  return z;
}

// Una pieza del spine. Full-bleed 9:16 (reframe cx/cy/zoom) o panel 4:5 (fit) sobre marca.
// `visual` = swap de B-roll: se VE otro archivo, el AUDIO sigue siendo el de la pieza.
const Cam: React.FC<{ p: Pieza; modo: Plan["modo"]; muted: boolean; eventos?: Evento[] }> = ({ p, modo, muted, eventos }) => {
  const frame = useCurrentFrame();
  const { fps, width: CW, height: CH } = useVideoConfig();
  const durF = Math.max(1, Math.round(p.dur * fps));
  const r = p.reframe;
  const punch = eventos ? punchInterno((p.atF ?? Math.round(p.at * fps)) + frame, fps, eventos) : 1;
  const zoom = interpolate(frame, [0, durF], [r.zoom, r.zoomTo ?? r.zoom], {
    extrapolateRight: "clamp", easing: Easing.inOut(Easing.ease),
  });
  // en paneles con tracking (cxKf) el centro SIGUE la cara a lo largo de la pieza
  const cx = r.fit && r.cxKf && r.cxKf.length >= 2
    ? interpolate(frame, r.cxKf.map(([f]) => f * durF), r.cxKf.map(([, x]) => x), {
        extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.ease),
      })
    : interpolate(frame, [0, durF], [r.cx, r.cxTo ?? r.cx], {
        extrapolateRight: "clamp", easing: Easing.inOut(Easing.ease),
      });
  const carpeta = modo === "proxy" ? "psrc" : "rsrc";
  const videoSrc = staticFile(`${carpeta}/${p.visual ? p.visual.src : p.src}`);
  const trim = p.visual ? Math.round(p.visual.in * fps) : undefined;
  const audioPropio = p.visual && !muted ? <Audio src={staticFile(`${carpeta}/${p.src}`)} /> : null;
  const vMuted = muted || !!p.visual;

  if (r.fit) {
    // PANEL 4:5 — llena ~75% del alto, recorta los lados de la fuente centrado en cx
    const W = CW - 52;                 // 1028
    const H = Math.round((W * 5) / 4); // 1285
    const TOP = Math.round((CH - H) / 2) - 24;
    const dispH = H * zoom;
    const dispW = SRC_W * (dispH / SRC_H);
    const left = Math.min(0, Math.max(W - dispW, W / 2 - cx * (dispW / SRC_W)));
    const cy = r.cy ?? SRC_H * 0.5;
    // con drift suave el crop se ancla ARRIBA (jamás corta la cabeza); el punch-in sí centra en cy
    const top = zoom <= 1.06 ? 0 : Math.min(0, Math.max(H - dispH, H / 2 - cy * (dispH / SRC_H)));
    const a = animPanel(frame, durF, !!r.enter, !!r.exit);
    const ac = animChip(frame, durF, !!r.enter, !!r.exit);
    return (
      <AbsoluteFill style={{ backgroundColor: BG }}>
        {audioPropio}
        <GlowMarca top={CH * 0.16} height={H + 320} />
        {p.titulo ? (
          <div
            style={{
              position: "absolute", left: 32, top: TOP - 78, display: "flex", alignItems: "center", gap: 18,
              fontFamily: "Inter Tight, Inter, sans-serif", fontWeight: 600, fontSize: 34,
              letterSpacing: 3, color: "#F4F7FA", ...ac,
            }}
          >
            <BarraChip h={34} p={ac.p} />
            {p.titulo}
          </div>
        ) : null}
        <div style={{ position: "absolute", left: 26, top: TOP, width: W, height: H, ...a }}>
          <div
            style={{
              width: "100%", height: "100%", overflow: "hidden", borderRadius: 20,
              border: "1px solid rgba(191,199,213,0.12)",
              boxShadow: "0 28px 76px rgba(0,0,0,0.65)",
            }}
          >
            <Media
              src={videoSrc}
              muted={vMuted}
              trimBefore={trim}
              style={{ position: "absolute", width: dispW, height: dispH, left, top, maxWidth: "none" }}
            />
          </div>
        </div>
      </AbsoluteFill>
    );
  }

  const dispH = CH * zoom;
  const dispW = SRC_W * (dispH / SRC_H);
  const left = CW / 2 - cx * (dispW / SRC_W);
  const cy = r.cy ?? SRC_H * 0.5;
  const top = Math.min(0, Math.max(CH - dispH, CH / 2 - cy * (dispH / SRC_H)));
  return (
    <AbsoluteFill style={{ overflow: "hidden", backgroundColor: BG }}>
      {audioPropio}
      <div style={{ position: "absolute", inset: 0, transform: `scale(${punch})`, transformOrigin: "50% 40%" }}>
        <Media
          src={videoSrc}
          muted={vMuted}
          trimBefore={trim}
          style={{ position: "absolute", width: dispW, height: dispH, left, top, maxWidth: "none" }}
        />
      </div>
    </AbsoluteFill>
  );
};

const Spine: React.FC<{ plan: Plan; muted: boolean }> = ({ plan, muted }) => {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill>
      {plan.piezas.map((p, i) => (
        <Sequence
          key={i}
          from={p.atF ?? Math.round(p.at * fps)}
          durationInFrames={Math.max(1, p.durF ?? Math.round(p.dur * fps))}
          premountFor={fps}
        >
          <Cam p={p} modo={plan.modo} muted={muted} eventos={plan.eventos} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

// Panel de Brian dentro del screencast: plano MEDIO abierto desde la fuente original.
const PanelCam: React.FC<{ plan: Plan; o: Overlay; W: number; H: number }> = ({ plan, o, W, H }) => {
  const { fps } = useVideoConfig();
  const piezas = plan.piezas.filter((p) => p.at < o.at + o.dur && p.at + p.dur > o.at);
  const dispH = H;
  const dispW = SRC_W * (dispH / SRC_H);
  const carpeta = plan.modo === "proxy" ? "psrc" : "rsrc";
  return (
    <>
      {piezas.map((p, i) => {
        const srcV = staticFile(`${carpeta}/${p.visual ? p.visual.src : p.src}`);
        const trim = p.visual ? Math.round(p.visual.in * fps) : undefined;
        const from = Math.round((p.at - o.at) * fps);
        const durF = Math.max(1, Math.round(p.dur * fps));
        if (p.reframe.fit) {
          return (
            <Sequence key={i} from={from} durationInFrames={durF} premountFor={30}>
              <Media src={srcV} muted trimBefore={trim} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            </Sequence>
          );
        }
        const left = Math.min(0, Math.max(W - dispW, W / 2 - p.reframe.cx * (dispW / SRC_W)));
        return (
          <Sequence key={i} from={from} durationInFrames={durF} premountFor={fps}>
            <Media src={srcV} muted trimBefore={trim}
              style={{ position: "absolute", width: dispW, height: dispH, left, top: 0, maxWidth: "none" }} />
          </Sequence>
        );
      })}
    </>
  );
};

// Screencast "dúo": pantalla grande arriba + Brian en plano medio abajo. Chip de título.
const Screencast: React.FC<{ o: Overlay; plan: Plan }> = ({ o, plan }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const durF = Math.max(1, Math.round(o.dur * fps));
  const drift = interpolate(frame, [0, durF], [1.0, 1.045], { extrapolateRight: "clamp" });
  const a = animPanel(frame, durF, true, true);
  const M = 26;
  const W = 1080 - M * 2;
  const H1 = Math.round((W * 9) / 16);
  const TOP1 = 400;
  const TOP2 = TOP1 + H1 + 22;
  const H2 = 1920 - TOP2 - 120;
  const srcZoom = o.srcZoom ?? 1.2;
  const srcY = o.srcY ?? -2.6;
  return (
    <AbsoluteFill style={{ backgroundColor: BG, opacity: a.opacity }}>
      <GlowMarca top={260} height={1400} />
      <div style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, transform: a.transform }}>
        {/* chip de título con entrada/salida propia escalonada */}
        <div
          style={{
            position: "absolute", left: M + 6, top: 318, display: "flex", alignItems: "center", gap: 18,
            fontFamily: "Inter Tight, Inter, sans-serif", fontWeight: 600, fontSize: 36,
            letterSpacing: 3.5, color: "#F4F7FA", ...animChip(frame, durF, true, true),
          }}
        >
          <BarraChip h={36} p={animChip(frame, durF, true, true).p} />
          {o.titulo ?? "PANTALLA"}
        </div>
        {/* PANEL 1: la pantalla */}
        <div
          style={{
            position: "absolute", left: M, top: TOP1, width: W, height: H1,
            borderRadius: 20, overflow: "hidden",
            border: "1px solid rgba(191,199,213,0.14)",
            boxShadow: "0 26px 70px rgba(0,0,0,0.6), 0 4px 18px rgba(0,229,255,0.05)",
          }}
        >
          <Media
            src={staticFile("fuentes/escena_plataformas.mp4")}
            muted
            trimBefore={Math.round(o.in * fps)}
            style={{
              width: "100%", height: "100%", objectFit: "cover",
              transform: `scale(${srcZoom * drift}) translateY(${srcY}%)`,
            }}
          />
          {/* blurs de privacidad (receta en el plan): tapan datos personales del screencast */}
          {(o.blurs ?? []).map((bl, bi) =>
            frame >= Math.round((bl.desde ?? 0) * fps) ? (
              <div
                key={bi}
                style={{
                  position: "absolute",
                  left: `${bl.x * 100}%`, top: `${bl.y * 100}%`,
                  width: `${bl.w * 100}%`, height: `${bl.h * 100}%`,
                  backdropFilter: "blur(34px)", WebkitBackdropFilter: "blur(34px)",
                  backgroundColor: "rgba(244,247,250,0.35)", borderRadius: 14,
                }}
              />
            ) : null)}
        </div>
        {/* PANEL 2: Brian en plano medio */}
        <div
          style={{
            position: "absolute", left: M, top: TOP2, width: W, height: H2,
            borderRadius: 20, overflow: "hidden",
            border: "1px solid rgba(191,199,213,0.10)",
            boxShadow: "0 18px 50px rgba(0,0,0,0.55)",
          }}
        >
          <PanelCam plan={plan} o={o} W={W} H={H2} />
        </div>
      </div>
    </AbsoluteFill>
  );
};

// HOOK — STACK XXL detrás de la silueta: fondo (spine) -> CUENTA/DE/TRADING gigante ->
// TÚ (webm con alpha, mismo encuadre que la pieza) -> "con IA" NY Italic grande a la izquierda
// + mini-tarjeta del trade real (+$550) a la derecha. Requiere fuentes/hook_alpha.webm.
const HookTitulo: React.FC<{ o: Overlay; plan: Plan }> = ({ o, plan }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const durF = Math.max(1, Math.round(o.dur * fps));
  const pz = plan.piezas[0];
  const r = pz.reframe;
  // réplica EXACTA del encuadre de la pieza 0 (panel 4:5 con paneo)
  const W = 1028, H = 1285, TOP = Math.round((1920 - H) / 2) - 24;
  const pzDurF = Math.max(1, Math.round(pz.dur * fps));
  const zoom = interpolate(frame, [0, pzDurF], [r.zoom, r.zoomTo ?? r.zoom], {
    extrapolateRight: "clamp", easing: Easing.inOut(Easing.ease),
  });
  const cx = r.cxKf && r.cxKf.length >= 2
    ? interpolate(frame, r.cxKf.map(([f]) => f * pzDurF), r.cxKf.map(([, x]) => x), {
        extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.ease),
      })
    : r.cx;
  const dispH = H * zoom;
  const dispW = SRC_W * (dispH / SRC_H);
  const left = Math.min(0, Math.max(W - dispW, W / 2 - cx * (dispW / SRC_W)));
  // el stack + silueta viven con la PIEZA 0 (salen con el corte de escena)
  const stackOut = interpolate(frame, [pzDurF - 16, pzDurF - 3], [1, 0], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.in(Easing.cubic),
  });
  // "con IA" vive hasta el final del overlay
  const eOut = interpolate(frame, [durF - 18, durF - 4], [1, 0], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.in(Easing.cubic),
  });
  const p = stackOut;
  // pop DURO por palabra: aparece de golpe en el frame en que la dices
  const pal = o.palabras ?? {};
  const pop = (t: number | undefined, fallbackF: number, salida: number) => {
    const f0 = t !== undefined ? Math.round(t * fps) : fallbackF;
    if (frame < f0) return { opacity: 0, transform: "scale(1.45)" };
    const s = interpolate(frame, [f0, f0 + 4], [1.45, 1.0], {
      extrapolateRight: "clamp", easing: Easing.out(Easing.cubic),
    });
    return { opacity: salida, transform: `scale(${s})` };
  };
  const popAbrir = pop(pal.abrir, 60, stackOut);
  const popCuenta = pop(pal.cuenta, 100, stackOut);
  const popDe = pop(pal.de, 120, stackOut);
  const popTrading = pop(pal.trading, 140, stackOut);
  const popIA = pop(pal.ia, 270, eOut);
  const card = Math.min(
    interpolate(frame, [132, 154], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) }),
    interpolate(frame, [durF - 16, durF - 2], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.in(Easing.cubic) }),
  );
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <style>{`@font-face{font-family:'NY Italic';src:url('${staticFile("fuentes/fonts/NewYorkItalic.ttf")}') format('truetype');}`}</style>
      {/* "CÓMO / ABRIR" en la banda negra superior */}
      <div
        style={{
          position: "absolute", top: 64, width: "100%", textAlign: "center",
          fontFamily: "Inter Tight, Inter, sans-serif", ...popAbrir,
        }}
      >
        <div style={{ fontWeight: 500, fontSize: 34, letterSpacing: 10, color: "#BFC7D5" }}>CÓMO</div>
        <div style={{ fontWeight: 900, fontSize: 118, letterSpacing: -2, color: "#F4F7FA", lineHeight: 1.05 }}>
          ABRIR
        </div>
      </div>
      {/* panel espejo: scrim de contraste + stack DETRÁS + silueta encima (mismo encuadre que la pieza 0) */}
      <div style={{ position: "absolute", left: 26, top: TOP, width: W, height: H, overflow: "hidden", borderRadius: 20 }}>
        <div
          style={{
            position: "absolute", top: 26, width: "100%", textAlign: "center",
            fontFamily: "Inter Tight, Inter, sans-serif", fontWeight: 900, fontSize: 178,
            lineHeight: 1.04, letterSpacing: -4, color: "#F4F7FA",
            textShadow: "0 4px 16px rgba(5,7,10,0.8), 0 12px 44px rgba(5,7,10,0.6)",
            WebkitTextStroke: "1.5px rgba(5,7,10,0.28)",
          }}
        >
          <div style={popCuenta}>CUENTA</div>
          <div style={popDe}>DE</div>
          <div style={popTrading}>TRADING</div>
        </div>
        {o.alpha && frame < pzDurF - 2 ? (
          <Media
            src={staticFile(plan.modo === "proxy" ? "fuentes/hook_alpha_proxy.webm" : "fuentes/hook_alpha.webm")}
            muted
            transparent
            style={{ position: "absolute", width: dispW, height: dispH, left, top: 0, maxWidth: "none" }}
          />
        ) : null}
        {/* "con IA" grande a la IZQUIERDA — pop duro cuando dices "inteligencia" */}
        <div
          style={{
            position: "absolute", left: 44, top: 636,
            fontFamily: "'NY Italic', Georgia, serif", fontSize: 104, color: CIAN,
            textShadow: "0 0 32px rgba(0,229,255,0.45), 0 6px 24px rgba(5,7,10,0.6)",
            ...popIA,
          }}
        >
          con IA
        </div>
      </div>
      {/* mini-tarjeta del trade real — esquina inferior derecha del panel */}
      <div
        style={{
          position: "absolute", left: 768, top: 1108, width: 260,
          opacity: card, transform: `translateX(${(1 - card) * 120}px)`,
        }}
      >
        <div
          style={{
            width: 260, height: 372, borderRadius: 24, overflow: "hidden",
            border: "1px solid rgba(191,199,213,0.20)", borderLeft: `4px solid ${CIAN}`,
            boxShadow: "0 26px 70px rgba(0,0,0,0.7)",
          }}
        >
          <Media
            src={staticFile("fuentes/telegram_cfr.mp4")}
            muted
            trimBefore={Math.round(o.in * fps)}
            style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "50% 14%" }}
          />
        </div>
        <div
          style={{
            marginTop: 12, textAlign: "center", fontFamily: "Inter Tight, Inter, sans-serif",
            textShadow: "0 4px 14px rgba(5,7,10,0.85)",
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 30, color: CIAN }}>+$550 USD</div>
          <div style={{ fontWeight: 500, fontSize: 19, letterSpacing: 3, color: "#BFC7D5" }}>TRADE REAL</div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Tarjeta flotante del CTA (teléfono a la derecha sobre el balcón): Telegram o el JUEGO.
const TarjetaCTA: React.FC<{ o: Overlay }> = ({ o }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const durF = Math.max(1, Math.round(o.dur * fps));
  const e = interpolate(frame, [0, 22], [0, 1], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const s = interpolate(frame, [durF - 14, durF], [1, 0], { extrapolateLeft: "clamp" });
  const p = Math.min(e, s);
  const CARD_W = 430;
  const CARD_H = Math.round(CARD_W * 2.0);
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute", left: 634, top: 200, width: CARD_W, height: CARD_H,
          opacity: p, transform: `translateX(${(1 - p) * 150}px)`,
        }}
      >
        <div
          style={{
            width: "100%", height: "100%", borderRadius: 40, overflow: "hidden",
            border: "1.5px solid rgba(191,199,213,0.22)",
            boxShadow: "0 34px 90px rgba(0,0,0,0.7), 0 6px 24px rgba(0,229,255,0.10)",
          }}
        >
          <Media
            src={staticFile(o.tipo === "app" ? "fuentes/juego_cfr.mp4" : "fuentes/telegram_cfr.mp4")}
            muted
            trimBefore={Math.round(o.in * fps)}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        </div>
        {/* chip bajo la tarjeta */}
        <div
          style={{
            marginTop: 18, display: "flex", flexDirection: "column", gap: 6,
            fontFamily: "Inter Tight, Inter, sans-serif",
            textShadow: "0 4px 14px rgba(5,7,10,0.85)",
          }}
        >
          {o.tipo === "app" ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <div style={{ width: 5, height: 32, background: CIAN, borderRadius: 3 }} />
                <span style={{ fontWeight: 700, fontSize: 31, letterSpacing: 1.5, color: "#F4F7FA" }}>
                  COMENTA <span style={{ color: CIAN }}>“JUEGO”</span>
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 14, paddingLeft: 19 }}>
                <span style={{ fontWeight: 500, fontSize: 25, letterSpacing: 3, color: "#BFC7D5" }}>
                  Y TE LO ENVÍO
                </span>
              </div>
            </>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <div style={{ width: 5, height: 32, background: CIAN, borderRadius: 3 }} />
                <span style={{ fontWeight: 700, fontSize: 32, letterSpacing: 1.5, color: "#F4F7FA" }}>
                  @MEGGAENDGAMELAB
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 14, paddingLeft: 19 }}>
                <span style={{ fontWeight: 500, fontSize: 24, letterSpacing: 3, color: "#BFC7D5" }}>
                  TELEGRAM · ACCESO
                </span>
                <span style={{ fontWeight: 700, fontSize: 26, letterSpacing: 3, color: CIAN }}>GRATIS</span>
              </div>
            </>
          )}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Sub viral: 3-5 palabras, bold, keyword cian, micro-pop de entrada. Sin caja, sombra limpia.
const SubViral: React.FC<{ s: Sub }> = ({ s }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const durF = Math.max(2, Math.round(((s.endMs - s.startMs) / 1000) * fps));
  const entra = interpolate(frame, [0, 6], [0, 1], {
    extrapolateRight: "clamp", easing: Easing.out(Easing.cubic),
  });
  const sale = interpolate(frame, [durF - 5, durF], [1, 0], {
    extrapolateLeft: "clamp", easing: Easing.in(Easing.cubic),
  });
  const op = Math.min(entra, sale);
  const pop = 0.955 + 0.045 * op;
  const alza = (1 - op) * 12;
  const partes = s.keyword
    ? s.text.split(new RegExp(`(${s.keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "i"))
    : [s.text];
  return (
    <div
      style={{
        position: "absolute", left: 110, right: 110, top: 1612, textAlign: "center",
        fontFamily: "Inter, Inter Tight, sans-serif", fontWeight: 700, fontSize: 44,
        lineHeight: 1.18, color: "#F4F7FA",
        textShadow: "0 4px 18px rgba(5,7,10,0.85), 0 1px 3px rgba(5,7,10,0.9)",
        opacity: op, transform: `translateY(${alza}px) scale(${pop})`,
      }}
    >
      {partes.map((t, i) =>
        s.keyword && t.toLowerCase() === s.keyword.toLowerCase() ? (
          <span key={i} style={{ color: CIAN }}>{t}</span>
        ) : (
          <span key={i}>{t}</span>
        ),
      )}
    </div>
  );
};

// transformación de eventos sobre TODO el lienzo: punch-in seco que decae + glide con
// deslizamiento, y micro-shake en los impactos. Devuelve transform + intensidades.
function efectosCanvas(frame: number, fps: number, eventos: Evento[]) {
  let escala = 1, tx = 0, blur = 0, flash = 0;
  for (const e of eventos) {
    const f0 = Math.round(e.at * fps);
    if (e.tipo === "glide") {
      if (frame >= f0 - 5 && frame <= f0 + 5) {
        const dir = f0 % 2 === 0 ? 1 : -1;
        tx += dir * interpolate(frame, [f0 - 5, f0, f0 + 5], [0, 40, 0]);
        // blur suave (antes 16px = se leía como fallo de foco al salir del screencast)
        blur = Math.max(blur, interpolate(frame, [f0 - 5, f0, f0 + 5], [0, 4, 0]));
      }
    } else if (e.tipo === "impacto") {
      if (frame >= f0 - 2 && frame <= f0 + 6) {
        flash = Math.max(flash, interpolate(frame, [f0 - 2, f0, f0 + 6], [0, 0.55, 0]));
        const jitter = [0, 6, -5, 4, -2, 1, 0, 0, 0][Math.max(0, frame - f0 + 2)] ?? 0;
        tx += jitter;
      }
    }
  }
  return { escala, tx, blur, flash };
}

// Chip flotante de dato (p. ej. TAKE PROFIT · $300–$500) en la banda negra superior
const ChipDato: React.FC<{ o: Overlay }> = ({ o }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const durF = Math.max(1, Math.round(o.dur * fps));
  const a = animChip(frame, durF, true, true);
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute", top: 208, width: "100%", display: "flex", justifyContent: "center",
        }}
      >
        <div
          style={{
            display: "flex", alignItems: "center", gap: 16, padding: "14px 26px",
            background: "rgba(10,14,19,0.88)", borderRadius: 14,
            border: "1px solid rgba(191,199,213,0.16)",
            boxShadow: "0 14px 44px rgba(0,0,0,0.55), 0 2px 12px rgba(0,229,255,0.08)",
            fontFamily: "Inter Tight, Inter, sans-serif", ...a,
          }}
        >
          <BarraChip h={30} p={a.p} />
          <span style={{ fontWeight: 600, fontSize: 30, letterSpacing: 2.5, color: "#F4F7FA" }}>
            {(o.titulo ?? "").split("·")[0]}
          </span>
          <span style={{ fontWeight: 700, fontSize: 32, letterSpacing: 1, color: CIAN }}>
            {(o.titulo ?? "").split("·")[1] ?? ""}
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const Reel: React.FC<ReelProps> = ({ plan }) => {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();
  if (!plan) return <AbsoluteFill style={{ backgroundColor: BG }} />;
  const fx = efectosCanvas(frame, fps, plan.eventos ?? []);
  return (
    <AbsoluteFill style={{ backgroundColor: BG }}>
      {/* AUDIO ÚNICO: voz + música + SFX mezclados (el spine va mudo) */}
      <Audio src={staticFile("audio_final.m4a")} />
      <div
        style={{
          position: "absolute", inset: 0,
          transform: `translateX(${fx.tx}px) scale(${fx.escala})`,
          transformOrigin: "50% 44%",
        }}
      >
      <Spine plan={plan} muted />
      {plan.overlays.map((o, i) => (
        <Sequence
          key={i}
          from={Math.round(o.at * fps)}
          durationInFrames={Math.max(1, Math.round(o.dur * fps))}
          premountFor={fps}
        >
          {o.tipo === "hook" ? (
            <HookTitulo o={o} plan={plan} />
          ) : o.tipo === "chip" ? (
            <ChipDato o={o} />
          ) : o.tipo === "telegram" || o.tipo === "app" ? (
            <TarjetaCTA o={o} />
          ) : (
            <Screencast o={o} plan={plan} />
          )}
        </Sequence>
      ))}
      {(plan.subs ?? []).map((s, i) => (
        <Sequence
          key={`sub${i}`}
          from={Math.round((s.startMs / 1000) * fps)}
          durationInFrames={Math.max(2, Math.round(((s.endMs - s.startMs) / 1000) * fps))}
        >
          <SubViral s={s} />
        </Sequence>
      ))}
      </div>
      {/* blur direccional del glide (sobre el contenido, no afecta layout) */}
      {fx.blur > 0.5 ? (
        <div style={{ position: "absolute", inset: 0, backdropFilter: `blur(${fx.blur}px)` }} />
      ) : null}
      {/* flash cian del impacto */}
      {fx.flash > 0.01 ? (
        <div
          style={{
            position: "absolute", inset: 0, opacity: fx.flash,
            background: "radial-gradient(circle at 50% 42%, rgba(0,229,255,0.55), rgba(0,229,255,0.08) 60%, rgba(5,7,10,0) 80%)",
          }}
        />
      ) : null}
    </AbsoluteFill>
  );
};
