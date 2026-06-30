import React from "react";
import {
  AbsoluteFill, Audio, CalculateMetadataFunction, Easing, interpolate, OffthreadVideo,
  Sequence, staticFile, useCurrentFrame, useVideoConfig,
} from "remotion";
import { loadFont } from "@remotion/google-fonts/InterTight";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import type { RenderPlan, Bloque, Zoom, Grade as GradeT, Broll, LowerThird as LT, Chip as ChipT, ClipMontage, Vertical as VertT } from "./plan";
import { CANVAS } from "./plan";

const { fontFamily: INTER_TIGHT } = loadFont();
const { fontFamily: INTER } = loadInter();
const APPLE = Easing.bezier(0.25, 0.1, 0.25, 1); // curva tipo Apple (F3)

// Caption de subtítulos (de captions.json por pieza).
type Cap = { t: string; s: number; e: number; w: { w: string; s: number }[] };

// Resuelve la URL de una fuente según el modo (proxy 1080p / 4k). Headroom de zoom en proxy.
const fuenteUrl = (plan: RenderPlan, clave: string) => {
  const f = plan.fuentes[clave];
  return staticFile(`china/${plan.modo === "proxy" ? f.proxy : f.full}`);
};
const brollUrl = (f: string) => staticFile(`china/${f}`);
const corteUrl = (plan: RenderPlan, src: string) =>
  plan.modo === "proxy" ? staticFile(`china/proxy/${src.replace(/\.MOV$/i, ".mp4")}`) : staticFile(`china/${src}`);

// ============ COLOR POR ESCENA (Bloque E, regla del 70%) ============
const FILTRO: Record<string, string> = {
  A1: "contrast(1.05) saturate(1.03)",                 // naturaleza fiel
  A2: "contrast(1.06) saturate(1.04)",                 // documental épico
  A3: "contrast(1.05) saturate(1.05) sepia(0.04)",     // hora dorada
  B1: "contrast(1.04) saturate(1.0) brightness(0.99)", // trading spotlight
  B2: "contrast(1.04) saturate(1.0)",
  B3: "contrast(1.05) brightness(1.02)",
  C1: "contrast(1.03) saturate(0.99)",                 // talking head, piel fiel
  C2: "contrast(1.04) saturate(1.01)",
  C3: "contrast(1.07) saturate(0.98) brightness(0.96)",
};
const Grade: React.FC<{ preset?: GradeT; liviano?: boolean; children: React.ReactNode }> = ({ preset = "C1", liviano, children }) => {
  const cat = preset[0];
  // En proxy (preview en la Mac vieja) NADA de color: ni filtro ni viñetas ni blend modes. Solo el
  // video crudo, para que el preview vaya fluido y Brian dirija estructura/broll/zooms/timing. Todo
  // el grade (filtro + viñeta + spotlight + split-tone del Bloque E) se aplica solo en el render 4K.
  // SIN_COLOR: grade DESACTIVADO para este render (cuerpo en color PLANO/NEUTRO). El grade va
  // despues, una sola vez, en Resolve sobre todo el video junto. Volver a false para reactivarlo.
  const SIN_COLOR = true;
  if (liviano || SIN_COLOR) return <>{children}</>;
  return (
    <AbsoluteFill style={{ filter: FILTRO[preset] ?? FILTRO.C1 }}>
      {children}
      <AbsoluteFill style={{
        background: cat === "B"
          ? "radial-gradient(ellipse at 50% 48%, transparent 40%, rgba(0,0,0,0.30) 100%)"  // spotlight
          : cat === "A"
            ? "radial-gradient(ellipse at center, transparent 66%, rgba(0,0,0,0.13) 100%)"   // viñeta 5-8%
            : "radial-gradient(ellipse at center, transparent 58%, rgba(0,0,0,0.20) 100%)",  // viñeta 8-12%
        pointerEvents: "none",
      }} />
      {/* split-tone mínimo solo en talking head: sombras frías, medios (piel) intactos */}
      {cat === "C" && <AbsoluteFill style={{ background: "#0e2233", mixBlendMode: "soft-light", opacity: 0.07, pointerEvents: "none" }} />}
    </AbsoluteFill>
  );
};

// ============ ZOOMS (Bloque F) ============
// Aplica TODOS los zooms de un bloque sobre su contenido. Cada tipo actúa solo en su rango.
const ConZoom: React.FC<{ zoom?: Zoom[]; durF: number; children: React.ReactNode }> = ({ zoom, durF, children }) => {
  const { fps } = useVideoConfig();
  const f = useCurrentFrame();
  const t = f / fps;
  let scale = 1, ox = "50%", oy = "38%";
  for (const z of zoom ?? []) {
    if (z.tipo === "punch" && t >= z.from && t <= z.to) {
      scale = z.magnitud ?? 1.16; // corte seco a B, sin animar sobre el rostro. Ojos en el tercio superior (oy 38%).
    } else if (z.tipo === "push" && t >= z.from && t <= z.to) {
      const a = z.dir === "out" ? [1.05, 1.0] : [1.0, 1.05];
      scale = interpolate(t, [z.from, z.to], a, { easing: APPLE, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    } else if (z.tipo === "panzoom" && t >= z.from && t <= z.to) {
      // Pan-zoom de chart (F3): acerca a la zona de precio de forma notoria, con un pan suave.
      scale = interpolate(t, [z.from, z.to], [z.de ?? 1.18, z.a ?? 1.42], { easing: APPLE, extrapolateRight: "clamp" });
      ox = `${(z.origenX ?? 0.55) * 100}%`; oy = `${(z.origenY ?? 0.48) * 100}%`;
    } else if (z.tipo === "enfasis" && t >= z.from && t <= z.to) {
      scale = interpolate(t, [z.from, z.to], [1.0, z.magnitud ?? 1.1], { easing: Easing.out(Easing.ease), extrapolateRight: "clamp" });
    }
  }
  return <AbsoluteFill style={{ transform: `scale(${scale})`, transformOrigin: `${ox} ${oy}` }}>{children}</AbsoluteFill>;
};

// ============ CAPAS DE TEXTO (no escalan con el clip) ============
// Subtítulos del episodio largo (brief v2 de Brian): Inter medium, discretos estilo Netflix, SIN caja.
// Legibilidad por contorno (stroke) fino oscuro, no sombra difusa ni bloque. Palabra clave en BOLD
// del mismo blanco (sin cian; el cian queda para chips/title/lower thirds). Máx 2 líneas, unidades de
// sentido. Entrada por frase: fade + subida 8-10px en 250-280ms ease-out; salida fade. Sin karaoke.
// Zona baja-centro dentro de la franja de 1080px (sobrevive al recorte 9:16 de los reels virales).
type Sub = { s: number; e: number; t: string; kw?: string };
const Subs: React.FC<{ subs: Sub[]; offset: number }> = ({ subs, offset }) => {
  const f = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const k = height / 1080;
  // Capa a tiempo ABSOLUTO del timeline (from=0). Los subs están en tiempo del vlog_proxy_final, que
  // empieza tras el title card; por eso restamos `offset` (duración del title card). Durante el title
  // card t<0 -> no hay sub. Determinista, sin Sequence relativo (que descuadraba).
  const t = f / fps - offset;
  const cap = subs.find((c) => t >= c.s && t <= c.e);
  if (!cap) return null;
  const local = t - cap.s;
  // Cine/documental premium: fade rápido (~100ms) de entrada y salida, SIN movimiento. El sub es una
  // herramienta de lectura invisible; cualquier slide/escala llamaría la atención sobre él.
  const op = interpolate(local, [0, 0.1, cap.e - cap.s - 0.1, cap.e - cap.s], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  // Limpiar el texto (espacios antes de signos, dobles espacios) y resaltar la keyword en bold blanco.
  const txt = cap.t.replace(/\s+([,.:;?!])/g, "$1").replace(/\s+/g, " ").trim();
  const palabras = txt.split(" ");
  const kwNorm = (cap.kw ?? "").toLowerCase().replace(/[^\wáéíóúñ]/g, "");
  const safe = (height * 9) / 16 * 0.92; // franja 9:16 segura
  const sw = 2.2 * k; // grosor del contorno, sutil
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", pointerEvents: "none" }}>
      <div style={{ marginBottom: 132 * k, maxWidth: Math.min(safe, width * 0.86), textAlign: "center",
        opacity: op, fontFamily: INTER, fontWeight: 500,
        fontSize: 31 * k, lineHeight: 1.2, color: "#F7F9FB",
        // contorno fino oscuro (paintOrder para que el stroke quede DETRÁS del relleno) + halo muy leve
        WebkitTextStroke: `${sw}px rgba(5,7,10,0.55)`, paintOrder: "stroke fill",
        textShadow: `0 ${1.5 * k}px ${5 * k}px rgba(5,7,10,0.45)` } as React.CSSProperties}>
        {palabras.map((w, i) => {
          const norm = w.toLowerCase().replace(/[^\wáéíóúñ]/g, "");
          const esKw = kwNorm && norm === kwNorm;
          return (
            <span key={i} style={esKw ? { fontWeight: 700 } : undefined}>
              {w}{i < palabras.length - 1 ? " " : ""}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
// Lower third de ubicación (C10). Entrada ESCALONADA: 1) línea de acento cian crece de izq a der,
// 2) título principal sube con fade, 3) línea secundaria con ~130ms de retraso. Jerarquía: nombre en
// Inter Tight semibold; secundaria más pequeña, tenue, MAYÚSCULAS con tracking abierto. Abajo-izq,
// sombra sutil para legibilidad sobre el agua. Inter Tight recta (no itálica).
const LowerThird: React.FC<LT & { dentro: boolean }> = ({ titulo, sub, at, dur, dentro }) => {
  const { fps, height } = useVideoConfig();
  const k = height / 1080;
  const f = useCurrentFrame();
  if (!dentro) return null;
  const local = f - Math.round(at * fps);
  const total = Math.round(dur * fps);
  const fadeOut = interpolate(local, [total - 16, total], [1, 0], { extrapolateLeft: "clamp" });
  // 1) línea de acento cian: frames 0-14 crece horizontal
  const lineW = interpolate(local, [0, 14], [0, 38 * k], { easing: APPLE, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  // 2) título: frames 8-22 fade + sube
  const tOp = interpolate(local, [8, 22], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const tY = interpolate(local, [8, 22], [9 * k, 0], { easing: APPLE, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  // 3) secundaria: frames 16-30 (retraso ~130ms tras el título)
  const sOp = interpolate(local, [16, 30], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const sY = interpolate(local, [16, 30], [7 * k, 0], { easing: APPLE, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const sombra = `0 ${2 * k}px ${12 * k}px rgba(5,7,10,0.6)`;
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "flex-start", pointerEvents: "none" }}>
      <div style={{ margin: `0 0 ${162 * k}px ${96 * k}px`, opacity: fadeOut, display: "flex", alignItems: "flex-start" }}>
        <div style={{ width: 4 * k, height: 46 * k, background: "#00E5FF", marginRight: 18 * k, marginTop: 3 * k,
          transform: `scaleY(${lineW / (38 * k)})`, transformOrigin: "top", borderRadius: 2 * k,
          boxShadow: `0 0 ${10 * k}px rgba(0,229,255,0.4)` }} />
        <div>
          <div style={{ fontFamily: INTER_TIGHT, fontWeight: 600, fontSize: 36 * k, color: "#F7F9FB",
            letterSpacing: "0.005em", opacity: tOp, transform: `translateY(${tY}px)`, textShadow: sombra }}>{titulo}</div>
          {sub && <div style={{ fontFamily: INTER, fontWeight: 400, fontSize: 19 * k, color: "#BFC7D5",
            marginTop: 6 * k, letterSpacing: "0.22em", opacity: sOp, transform: `translateY(${sY}px)`,
            textShadow: sombra }}>{sub.toUpperCase()}</div>}
        </div>
      </div>
    </AbsoluteFill>
  );
};
// Chip de dato de trading (C10), estilo CINE — sin caja, sin fondo, sin borde redondeado:
// etiqueta pequeña arriba (tracking, plata) + número grande limpio (Inter Tight, sombra de subs) +
// línea de acento cian fina debajo que crece. En zona tranquila del encuadre. verde=true para "+$500".
// Aparece con fade rápido + micro scale (no de golpe).
const Chip: React.FC<ChipT & { verde?: boolean; at: number; dur: number }> = ({ label, valor, x = 0.62, y = 0.4, verde, at, dur }) => {
  const { fps, height } = useVideoConfig();
  const k = height / 1080;
  const f = useCurrentFrame();
  const local = f - Math.round(at * fps);
  const total = Math.round(dur * fps);
  // Animación ESCALONADA y elegante (como el lower third), sin scale que "salte":
  // 1) línea de acento cian crece de izq a der, 2) número sube con fade, 3) etiqueta con retraso.
  const fadeOut = interpolate(local, [total - 14, total], [1, 0], { extrapolateLeft: "clamp" });
  const lineW = interpolate(local, [0, 15], [0, 110 * k], { easing: APPLE, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const nOp = interpolate(local, [7, 22], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const nY = interpolate(local, [7, 22], [10 * k, 0], { easing: APPLE, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const lOp = interpolate(local, [16, 30], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const sombra = `0 ${2 * k}px ${12 * k}px rgba(5,7,10,0.65), 0 ${1 * k}px ${4 * k}px rgba(5,7,10,0.5)`;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{ position: "absolute", left: `${x * 100}%`, top: `${y * 100}%`, opacity: fadeOut }}>
        <div style={{ fontFamily: INTER, fontWeight: 500, fontSize: 20 * k, color: "#9FB0C0", letterSpacing: "0.18em", textShadow: sombra, opacity: lOp }}>{label.toUpperCase()}</div>
        <div style={{ fontFamily: INTER_TIGHT, fontWeight: 700, fontSize: 62 * k, lineHeight: 1.05, marginTop: 4 * k,
          color: verde ? "#34E27A" : "#F7F9FB", textShadow: sombra, opacity: nOp, transform: `translateY(${nY}px)` }}>{valor}</div>
        <div style={{ width: lineW, height: 4 * k, background: "#00E5FF", marginTop: 12 * k, borderRadius: 2 * k, boxShadow: `0 0 ${10 * k}px rgba(0,229,255,0.4)` }} />
      </div>
    </AbsoluteFill>
  );
};

// B-roll cutaway (audio del spine sigue por debajo; ambiente sube el sonido del clip).
const Cutaway: React.FC<{ b: Broll }> = ({ b }) => {
  const { fps } = useVideoConfig();
  const f = useCurrentFrame();
  const durF = Math.round(b.dur * fps);
  const op = interpolate(f, [0, 8, durF - 8, durF], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ opacity: op }}>
      <Grade preset={b.grade ?? "A1"}><OffthreadVideo src={brollUrl(b.clip)} muted={!b.ambiente} toneMapped={false} /></Grade>
    </AbsoluteFill>
  );
};

// Montage: interludio de B-roll SIN voz (la música manda). Cada toma con grade A de naturaleza,
// crossfade suave y un push lento (Ken Burns) muy sutil para que respire. Da el "wow" del lugar.
const MontageClip: React.FC<{ c: ClipMontage; durF: number }> = ({ c, durF }) => {
  const f = useCurrentFrame();
  const op = interpolate(f, [0, 9, durF - 9, durF], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const scale = interpolate(f, [0, durF], [1.0, 1.05], { easing: APPLE, extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ opacity: op }}>
      <Grade preset={c.grade ?? "A1"}>
        <AbsoluteFill style={{ transform: `scale(${scale})` }}>
          <OffthreadVideo src={brollUrl(c.clip)} muted={!c.ambiente} toneMapped={false} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        </AbsoluteFill>
      </Grade>
    </AbsoluteFill>
  );
};
const Montage: React.FC<{ clips: ClipMontage[] }> = ({ clips }) => {
  const { fps } = useVideoConfig();
  const cross = Math.round(0.3 * fps);
  let acc = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {clips.map((c, i) => {
        const durF = Math.round(c.dur * fps);
        const from = Math.max(0, acc - (i > 0 ? cross : 0)); // solape de 0.3s = crossfade real
        acc = from + durF;
        return <Sequence key={i} from={from} durationInFrames={durF}><MontageClip c={c} durF={durF} /></Sequence>;
      })}
    </AbsoluteFill>
  );
};

// ============ BLOQUES ============
export const bloqueDur = (b: Bloque, fps: number): number => {
  if (b.tipo === "habla" || b.tipo === "trading") return Math.max(1, Math.round((b.dur ?? 1) * fps));
  if (b.tipo === "trailer") return Math.round((b.dur ?? 8.4) * fps);
  if (b.tipo === "title_card") return Math.round(5.5 * fps);
  if (b.tipo === "montage") {
    const cs = b.clips ?? []; const cross = Math.round(0.3 * fps);
    return cs.reduce((s, c) => s + Math.round(c.dur * fps), 0) - Math.max(0, cs.length - 1) * cross || Math.round(6 * fps);
  }
  if (b.tipo === "cold_open") return (b.frags ?? []).reduce((s, fr) => s + Math.round(fr.dur * fps), 0) || Math.round(6 * fps);
  if (b.tipo === "outro") return Math.round(8 * fps);
  return fps;
};

// Title card de apertura: establishing de las terrazas de Huanglong + título blanco premium abajo-izq.
// El cian SOLO como línea de acento fina (no en el texto). Push lento sutil del fondo. El título entra
// ~1.2s después del primer frame (deja respirar la postal) y se mantiene; salida en fade al final.
const TitleCard: React.FC<{ clip?: string }> = ({ clip }) => {
  const f = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const k = height / 1080;
  const durF = Math.round(5.5 * fps);
  const fadeOut = interpolate(f, [durF - 22, durF], [1, 0], { extrapolateLeft: "clamp" });
  const scale = interpolate(f, [0, durF], [1.0, 1.06], { easing: APPLE, extrapolateRight: "clamp" }); // push lento
  // Título: aparece a ~1.2s (frame 72) con fade. Línea de acento cian crece de izq a der antes.
  const tA = Math.round(1.2 * fps);
  const lineW = interpolate(f, [tA, tA + 16], [0, 56 * k], { easing: APPLE, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const txtOp = interpolate(f, [tA + 10, tA + 26], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const ty = 150 * k;
  return (
    <AbsoluteFill style={{ backgroundColor: "#000", opacity: fadeOut }}>
      {clip ? (
        <Grade preset="A1">
          <AbsoluteFill style={{ transform: `scale(${scale})` }}>
            <OffthreadVideo src={brollUrl(clip)} muted toneMapped={false} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          </AbsoluteFill>
        </Grade>
      ) : <AbsoluteFill style={{ backgroundColor: "#05070A" }} />}
      {/* degradado de legibilidad abajo */}
      <AbsoluteFill style={{ background: "linear-gradient(to top, rgba(5,7,10,0.62) 0%, transparent 38%)" }} />
      <div style={{ position: "absolute", left: 96 * k, bottom: ty }}>
        <div style={{ width: lineW, height: 4 * k, background: "#00E5FF", marginBottom: 18 * k }} />
        <div style={{ fontFamily: INTER_TIGHT, color: "#F7F9FB", fontSize: 50 * k, fontWeight: 700,
          letterSpacing: "0.02em", opacity: txtOp, textShadow: `0 ${2 * k}px ${14 * k}px rgba(5,7,10,0.55)` }}>
          TRADING DESDE EL CIELO
        </div>
      </div>
    </AbsoluteFill>
  );
};

const BloqueAV: React.FC<{ plan: RenderPlan; b: Bloque; caps: Cap[]; durF: number }> = ({ plan, b, caps, durF }) => {
  const { fps } = useVideoConfig();
  const f = useCurrentFrame();
  const t = f / fps;
  const sg = plan.soloGraficos === true;  // capa alpha: sin video de fondo
  if (b.tipo === "trailer") return sg ? null : (
    // Cold open de impacto. MUTEADO: su audio (música misteriosa + voz) va dentro de la mezcla global
    // audio_full, que cubre TODO el timeline desde el frame 0 (sin offsets -> imposible descuadrar).
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <OffthreadVideo src={brollUrl(b.clips?.[0]?.clip ?? "broll/trailer.mp4")} muted toneMapped={false} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    </AbsoluteFill>
  );
  if (b.tipo === "title_card") return sg ? null : <TitleCard clip={b.clips?.[0]?.clip} />;
  if (b.tipo === "montage") return sg ? null : <Montage clips={b.clips ?? []} />;
  const grade = b.grade ?? (b.tipo === "trading" ? "B1" : "C1");
  return (
    <AbsoluteFill style={sg ? undefined : { backgroundColor: "#000" }}>
      {!sg && (
        <Grade preset={grade} liviano={plan.modo === "proxy"}>
          <ConZoom zoom={b.zoom} durF={durF}>
            {b.cortes ? b.cortes.map((c, i) => (
              <Sequence key={`co${i}`} from={Math.round(c.at * fps)} durationInFrames={Math.round(c.dur * fps)}>
                <OffthreadVideo src={corteUrl(plan, c.src)} trimBefore={Math.round(c.in * fps)} toneMapped={false} muted />
              </Sequence>
            )) : (
              <OffthreadVideo src={fuenteUrl(plan, b.fuente ?? "vlog")} trimBefore={Math.round((b.from ?? 0) * fps)} toneMapped={false} muted={!!plan.audio} />
            )}
          </ConZoom>
        </Grade>
      )}
      {!sg && (b.broll ?? []).map((br, i) => (
        <Sequence key={i} from={Math.round(br.at * fps)} durationInFrames={Math.round(br.dur * fps)}><Cutaway b={br} /></Sequence>
      ))}
      {!sg && (b.vertical ?? []).map((v, i) => (
        <Sequence key={`v${i}`} from={Math.round(v.at * fps)} durationInFrames={Math.round(v.dur * fps)}><VerticalInsert {...v} /></Sequence>
      ))}
      {(b.lowerThirds ?? []).map((lt, i) => <LowerThird key={`l${i}`} {...lt} dentro={t >= lt.at && t <= lt.at + lt.dur} />)}
      {(b.chips ?? []).filter((c) => t >= c.at && t <= c.at + c.dur).map((c, i) => <Chip key={`c${i}`} {...c} verde={(c as ChipT & { verde?: boolean }).verde} />)}
    </AbsoluteFill>
  );
};

// Las 5 formas de usar contenido vertical (memoria formas-contenido-vertical). Fondo oscuro de
// marca sólido, esquinas redondeadas, NUNCA blur estirado (B5).
const VerticalInsert: React.FC<VertT> = ({ clip, forma = "marco", texto, clip2 }) => {
  const { height } = useVideoConfig();
  const k = height / 1080;
  const vid = (c: string) => <OffthreadVideo src={brollUrl(c)} style={{ height: "100%", width: "100%", objectFit: "cover" }} toneMapped={false} />;
  const BG = "#05070A";

  if (forma === "centrado") {
    // Centrado contemplativo: clip 9:16 alto y centrado, aire generoso a los lados, sin borde duro.
    return (
      <AbsoluteFill style={{ backgroundColor: BG, justifyContent: "center", alignItems: "center" }}>
        <div style={{ height: "90%", aspectRatio: "9/16", borderRadius: 20 * k, overflow: "hidden",
          boxShadow: `0 ${10 * k}px ${50 * k}px rgba(0,0,0,0.55)` }}>{vid(clip)}</div>
      </AbsoluteFill>
    );
  }
  if (forma === "punch16") {
    // Recorte a 16:9 a pantalla completa (solo si el encuadre conserva rostro y manos).
    return <AbsoluteFill style={{ backgroundColor: "#000" }}>{vid(clip)}</AbsoluteFill>;
  }
  if (forma === "duo") {
    // Dos 9:16 lado a lado con gap de 24px.
    return (
      <AbsoluteFill style={{ backgroundColor: BG, justifyContent: "center", alignItems: "center", gap: 24 * k, flexDirection: "row" }}>
        {[clip, clip2 ?? clip].map((c, i) => (
          <div key={i} style={{ height: "82%", aspectRatio: "9/16", borderRadius: 18 * k, overflow: "hidden" }}>{vid(c)}</div>
        ))}
      </AbsoluteFill>
    );
  }
  if (forma === "panel") {
    // Panel pilar: clip a un tercio + texto/dato al lado.
    return (
      <AbsoluteFill style={{ backgroundColor: BG, alignItems: "center", flexDirection: "row", paddingLeft: "8%", gap: "5%" }}>
        <div style={{ height: "84%", aspectRatio: "9/16", borderRadius: 20 * k, overflow: "hidden", flexShrink: 0 }}>{vid(clip)}</div>
        {texto && (
          <div>
            <div style={{ fontFamily: INTER_TIGHT, fontWeight: 700, fontSize: 56 * k, color: "#F4F7FA", lineHeight: 1.05 }}>{texto.titulo}</div>
            {texto.sub && <div style={{ fontFamily: INTER, fontWeight: 400, fontSize: 30 * k, color: "#BFC7D5", marginTop: 14 * k }}>{texto.sub}</div>}
          </div>
        )}
      </AbsoluteFill>
    );
  }
  // marco (default): fondo de marca sólido, esquinas redondeadas, borde sutil.
  return (
    <AbsoluteFill style={{ backgroundColor: BG, justifyContent: "center", alignItems: "center" }}>
      <div style={{ height: "82%", aspectRatio: "9/16", borderRadius: 26 * k, overflow: "hidden",
        border: `${Math.max(1, k)}px solid rgba(255,255,255,0.1)` }}>{vid(clip)}</div>
    </AbsoluteFill>
  );
};

export type VlogProps = { plan: RenderPlan; subs: Sub[] };

export const Vlog: React.FC<VlogProps> = ({ plan, subs }) => {
  const { fps } = useVideoConfig();
  let acc = 0;
  // Offset de los subs (en SEGUNDOS) = duración de los bloques ANTES del primer bloque "habla"
  // (el title card). Se lo pasamos al componente, que lo resta. Capa a tiempo absoluto (from=0).
  let offSubF = 0;
  for (const b of plan.timeline) { if (b.tipo === "habla") break; offSubF += bloqueDur(b, fps); }
  const offSubSec = offSubF / fps;
  const sg = plan.soloGraficos === true;  // capa alpha (sin fondo ni audio): se compone sobre el HDR
  return (
    <AbsoluteFill style={sg ? undefined : { backgroundColor: "#000" }}>
      {/* Pista de audio global ÚNICA: audio_full cubre TODO el timeline (trailer + title + habla) desde
          el frame 0. Sin Sequence ni offset -> el audio nunca se puede descuadrar. Todos los videos
          van muteados (incluido el trailer, cuyo audio ya está dentro de esta mezcla). */}
      {/* En soloGraficos mantenemos el audio: este render entrega la mezcla final completa
          (audio_full música+voz + los SFX de las transiciones) que se muxea al MP4 HDR. */}
      {plan.audio && !sg && <Audio src={staticFile(`china/${plan.audio}`)} />}
      {plan.timeline.map((b, i) => {
        const durF = bloqueDur(b, fps);
        const from = acc; acc += durF;
        return (
          <Sequence key={i} from={from} durationInFrames={durF}>
            <BloqueAV plan={plan} b={b} caps={[]} durF={durF} />
          </Sequence>
        );
      })}
      {/* Subtítulos: mapeados al vlog_proxy_final; se desplazan por offSubF (el title card al inicio).
          Quedan fuera de los montages porque ahí no hay frases (no hay voz). */}
      {subs.length > 0 && (
        <Sequence from={0}><Subs subs={subs} offset={offSubSec} /></Sequence>
      )}
      {/* Transiciones (C2). tr.at está en tiempo del CONTENIDO (vlog_proxy_final), igual que los subs:
          se desplaza por offSubSec (trailer+title). Así NUNCA se descuadra si cambia la duración del
          trailer/title — sigue al video, no al timeline absoluto. */}
      {(plan.transiciones ?? []).map((tr, i) => {
        const def = tr.tipo === "impacto" ? (tr.fuerza === "rapido" ? 0.34 : 0.55) : tr.tipo === "whip" ? 0.3 : 0.5;
        const d = Math.round((tr.dur ?? def) * fps);
        const at = Math.round((tr.at + offSubSec) * fps);
        return (
          <Sequence key={`t${i}`} from={at - Math.round(d / 2)} durationInFrames={d}>
            {tr.tipo === "dip_black" ? <DipBlack durF={d} sinAudio={sg} />
              : tr.tipo === "whip" ? <Whip durF={d} whoosh={tr.whoosh === true} sinAudio={sg} />
              : <ImpactoCian durF={d} fuerza={tr.fuerza ?? "fuerte"} whoosh={tr.whoosh !== false} sinAudio={sg} />}
          </Sequence>
        );
      })}
      {/* Transición suave trailer -> cold open: el cuerpo entra fundiéndose desde el negro del title card.
          Solo si hay trailer al inicio. offSubF = frame donde empieza el habla (fin del trailer). */}
      {plan.timeline[0]?.tipo === "trailer" && (
        <Sequence from={offSubF} durationInFrames={Math.round(0.6 * fps)}>
          <FadeFromBlack durF={Math.round(0.6 * fps)} />
        </Sequence>
      )}
    </AbsoluteFill>
  );
};

// Fundido de entrada desde negro: negro pleno -> transparente. Suaviza el paso del trailer al cold open.
const FadeFromBlack: React.FC<{ durF: number }> = ({ durF }) => {
  const f = useCurrentFrame();
  const op = interpolate(f, [0, durF], [1, 0], { easing: APPLE, extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ backgroundColor: "#000", opacity: op }} />;
};

const DipBlack: React.FC<{ durF: number; sinAudio?: boolean }> = ({ durF, sinAudio }) => {
  const f = useCurrentFrame();
  // MESETA: sube a negro pleno, se MANTIENE (cubre el residuo de escena no deseado) y baja revelando la
  // escena buena. ~50% de la duración en negro total.
  const op = interpolate(f, [0, durF * 0.22, durF * 0.72, durF], [0, 1, 1, 0], { easing: APPLE, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ backgroundColor: "#000", opacity: op }}>
      {!sinAudio && <Audio src={staticFile("china/audio/sfx/sub_drop.mp3")} volume={0.4} />}
    </AbsoluteFill>
  );
};

// Whip / desenfoque de movimiento: latigazo de corte dinámico para B-roll y viaje. Desenfoque fuerte
// y breve sobre lo que hay debajo (backdrop blur), con leve oscurecida + micro-empuje horizontal que
// da la dirección del barrido. Sin negro pleno: la imagen no se va, se "barre". Whoosh corto opcional.
const Whip: React.FC<{ durF: number; whoosh: boolean; sinAudio?: boolean }> = ({ durF, whoosh, sinAudio }) => {
  const f = useCurrentFrame();
  const blur = interpolate(f, [0, durF * 0.5, durF], [0, 28, 0], { easing: APPLE, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const dark = interpolate(f, [0, durF * 0.5, durF], [0, 0.34, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  // El desenfoque cubre TODA la pantalla (sin translate, que dejaba una esquina sin tapar). La sensación
  // de "barrido" la da una banda de oscurecida que recorre en horizontal DENTRO del fill (no mueve el fill).
  const sweep = interpolate(f, [0, durF], [-30, 130], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const band = `linear-gradient(100deg, transparent ${sweep - 30}%, rgba(5,7,10,0.5) ${sweep}%, transparent ${sweep + 30}%)`;
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ backdropFilter: `blur(${blur}px)`, WebkitBackdropFilter: `blur(${blur}px)`, backgroundColor: `rgba(5,7,10,${dark})` } as React.CSSProperties} />
      <AbsoluteFill style={{ background: band, opacity: 0.9, pointerEvents: "none" }} />
      {whoosh && !sinAudio && <Audio src={staticFile("china/audio/sfx/whip_swoosh.mp3")} volume={0.6} />}
    </AbsoluteFill>
  );
};

// Transición de impacto, sistema visual de la serie (negro/plata/CIAN, sobrio premium, NO HUD).
// 1) Negro entra rápido y profundo (pico ~40% del tramo). 2) Al reabrir, una BANDA de luz cian barre
// la pantalla en horizontal con glow (screen blend) — energía con el color de marca, no un flash blanco
// barato. "rapido" no llega a negro pleno (corte interno); "fuerte" sí (cambio de capítulo).
const ImpactoCian: React.FC<{ durF: number; fuerza: "fuerte" | "rapido"; whoosh: boolean; sinAudio?: boolean }> = ({ durF, fuerza, whoosh, sinAudio }) => {
  const f = useCurrentFrame();
  const peak = fuerza === "fuerte" ? 1 : 0.8;
  // dip a negro: sube rápido a 'peak' (~40%), breve meseta, baja
  const black = interpolate(f, [0, durF * 0.38, durF * 0.5, durF], [0, peak, peak, 0],
    { easing: APPLE, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  // banda de luz cian que barre de izq a der durante la reapertura
  const sx = interpolate(f, [durF * 0.36, durF], [-22, 122], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const glow = interpolate(f, [durF * 0.36, durF * 0.6, durF], [0, fuerza === "fuerte" ? 0.95 : 0.7, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const band = `linear-gradient(105deg, transparent ${sx - 16}%, rgba(0,229,255,0.0) ${sx - 9}%, rgba(0,229,255,0.9) ${sx}%, rgba(120,245,255,0.0) ${sx + 9}%, transparent ${sx + 16}%)`;
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ backgroundColor: "#000", opacity: black }} />
      <AbsoluteFill style={{ background: band, opacity: glow, mixBlendMode: "screen", pointerEvents: "none" }} />
      {whoosh && !sinAudio && <Audio src={staticFile("china/audio/sfx/impact_cian.mp3")} volume={fuerza === "fuerte" ? 0.9 : 0.55} />}
    </AbsoluteFill>
  );
};

export const calcVlog: CalculateMetadataFunction<VlogProps> = async () => {
  const plan: RenderPlan = await fetch(staticFile("render_plan.json")).then((r) => r.json());
  const subs: Sub[] = await fetch(staticFile("china/subs/subs.json")).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const fps = plan.fps ?? 60;
  const total = (plan.timeline ?? []).reduce((s, b) => s + bloqueDur(b, fps), 0);
  const dim = CANVAS[plan.modo ?? "4k"];
  return { durationInFrames: Math.max(fps, total), fps, width: dim.width, height: dim.height, props: { plan, subs } };
};
