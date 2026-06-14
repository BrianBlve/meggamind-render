import React from "react";
import {
  AbsoluteFill,
  Audio,
  CalculateMetadataFunction,
  Easing,
  interpolate,
  OffthreadVideo,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { loadFont } from "@remotion/google-fonts/InterTight";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";

const { fontFamily: INTER_TIGHT } = loadFont();
const { fontFamily: INTER } = loadInter();

// Composición del Vlog. Spec del director: render 1080p con fuentes 4K (headroom de zoom),
// protocolo de zoom (punch-in por CORTE en rostro, push lento solo en planos largos, pan-zoom en
// charts), grade por categoría con topes, y capas de texto que NUNCA escalan con el clip.
type Palabra = { w: string; s: number };
type Caption = { t: string; s: number; e: number; w: Palabra[] };
type Frag = {
  video: string;
  from?: number;
  dur: number;
  conAudio?: boolean;
  vo?: { src: string; from: number; dur: number };
  grade?: "A1" | "B1" | "C1";
};
type Bloque = {
  tipo: "habla" | "trading" | "title_card" | "cold_open" | "outro";
  video?: string;
  dur?: number;
  grade?: "A1" | "B1" | "C1";
  zoom?: "punch" | "panzoom" | "kenburns";
  captions?: Caption[];
  broll?: string[];
  frags?: Frag[];
};
export type VlogProps = { fps: number; bloques: Bloque[] };

const vidUrl = (f: string) => staticFile(`china/${f}`);
// Curva Apple, sin overshoot ni rebote.
const APPLE = Easing.bezier(0.25, 0.1, 0.25, 1);

// --- Grade por categoría (regla del 70%: sutil). Las piezas ya vienen SDR de Descript. ---
// A1 naturaleza fiel · B1 trading spotlight · C1 talking head piel fiel.
const FILTRO: Record<string, string> = {
  A1: "contrast(1.04) saturate(1.03)",                 // naturaleza: realidad con 5% de drama
  B1: "contrast(1.04) saturate(1.0) brightness(0.99)", // trading: legibilidad manda
  C1: "contrast(1.03) saturate(0.99)",                 // talking head: piel fiel, prioridad absoluta
};
const Grade: React.FC<{ preset?: string; children: React.ReactNode }> = ({ preset = "C1", children }) => (
  <AbsoluteFill style={{ filter: FILTRO[preset] ?? FILTRO.C1 }}>
    {children}
    {/* Viñeta: A1 5-8%, B1 spotlight direccional 10-15%, C1 8-12%. */}
    <AbsoluteFill style={{
      background: preset === "B1"
        ? "radial-gradient(ellipse at 50% 48%, transparent 40%, rgba(0,0,0,0.30) 100%)"
        : preset === "A1"
          ? "radial-gradient(ellipse at center, transparent 66%, rgba(0,0,0,0.14) 100%)"
          : "radial-gradient(ellipse at center, transparent 58%, rgba(0,0,0,0.20) 100%)",
      pointerEvents: "none",
    }} />
    {/* Split-tone mínimo solo en talking head: sombras frías, sin tocar los medios (piel). */}
    {preset === "C1" && (
      <AbsoluteFill style={{ background: "#0e2233", mixBlendMode: "soft-light", opacity: 0.07, pointerEvents: "none" }} />
    )}
  </AbsoluteFill>
);

// --- TIPO 1: punch-in por CORTE en talking head (multicámara simulada). ---
// Dos tamaños fijos A(100%) y B(~116%); el cambio es un CORTE seco, jamás animado sobre el rostro.
// Los cortes caen al arranque de las frases (palabras de énfasis), no en pausas. Anclaje: el rostro.
const punchScaleAt = (segundos: number, captions?: Caption[]): number => {
  // Puntos de corte = arranque de frases, espaciados al menos ~8 s (cada 8-20 s según la spec).
  const cortes: number[] = [0];
  for (const c of captions ?? []) {
    if (c.s - cortes[cortes.length - 1] >= 9) cortes.push(c.s);
  }
  // Índice del segmento actual; alterna A/B (dos cortes seguidos al mismo tamaño quedan prohibidos).
  let idx = 0;
  for (let i = 0; i < cortes.length; i++) if (segundos >= cortes[i]) idx = i;
  return idx % 2 === 0 ? 1.0 : 1.16;
};
const PunchCut: React.FC<{ captions?: Caption[]; children: React.ReactNode }> = ({ captions, children }) => {
  const { fps } = useVideoConfig();
  const f = useCurrentFrame();
  const scale = punchScaleAt(f / fps, captions);
  // Sin transición: scale constante por segmento => corte seco. Ojos en el tercio superior.
  return (
    <AbsoluteFill style={{ transform: `scale(${scale})`, transformOrigin: "50% 36%" }}>
      {children}
    </AbsoluteFill>
  );
};

// --- TIPO 2: push lento (respiración), solo en planos largos de naturaleza. 3-5% en todo el plano. ---
const PushSlow: React.FC<{ durFrames: number; dir?: "in" | "out"; origin?: string; children: React.ReactNode }> = ({
  durFrames, dir = "in", origin = "50% 45%", children,
}) => {
  const f = useCurrentFrame();
  const a = dir === "in" ? [1.0, 1.05] : [1.05, 1.0];
  const scale = interpolate(f, [0, durFrames], a, { easing: APPLE, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ transform: `scale(${scale})`, transformOrigin: origin }}>{children}</AbsoluteFill>;
};

// --- TIPO 3: pan-zoom narrativo sobre charts. Push lento hacia la zona de precio (centro-derecha). ---
const PanZoomChart: React.FC<{ durFrames: number; children: React.ReactNode }> = ({ durFrames, children }) => {
  const f = useCurrentFrame();
  const scale = interpolate(f, [0, durFrames], [1.0, 1.06], { easing: APPLE, extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ transform: `scale(${scale})`, transformOrigin: "58% 50%" }}>{children}</AbsoluteFill>;
};

// --- Capa de subtítulos de marca. Inter, 2 líneas máx, zona inferior fija. NUNCA escala con el clip. ---
const Subs: React.FC<{ captions: Caption[] }> = ({ captions }) => {
  const f = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const k = height / 1080; // escala los textos a la resolución (1080p=1, 4K=2)
  const t = f / fps;
  const cap = captions.find((c) => t >= c.s && t <= c.e + 0.2);
  if (!cap) return null;
  const inOp = interpolate(t, [cap.s, cap.s + 0.13], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", pointerEvents: "none" }}>
      <div style={{
        marginBottom: 78 * k, maxWidth: 1400 * k, textAlign: "center", opacity: inOp,
        fontFamily: INTER, fontWeight: 500, fontSize: 40 * k, lineHeight: 1.25,
        color: "#F4F7FA", textShadow: `0 ${2 * k}px ${12 * k}px rgba(5,7,10,0.7)`,
      }}>
        {cap.w.map((p, i) => (
          // Palabra hablada: peso medio normal; aún no dicha: 55% de opacidad (karaoke sutil).
          <span key={i} style={{ opacity: t >= p.s ? 1 : 0.55 }}>{p.w}{" "}</span>
        ))}
      </div>
    </AbsoluteFill>
  );
};

// --- Lower third: línea principal + secundaria tenue. Fade + elevación 10px, ease-out (~350 ms). ---
const LowerThird: React.FC<{ titulo: string; sub?: string; entra: number; dur: number }> = ({ titulo, sub, entra, dur }) => {
  const { fps, height } = useVideoConfig();
  const k = height / 1080;
  const f = useCurrentFrame();
  const local = f - Math.round(entra * fps);
  const total = Math.round(dur * fps);
  if (local < 0 || local > total) return null;
  const op = interpolate(local, [0, 12, total - 14, total], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const y = interpolate(local, [0, 14], [10 * k, 0], { easing: APPLE, extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "flex-start", pointerEvents: "none" }}>
      <div style={{ margin: `0 0 ${150 * k}px ${96 * k}px`, opacity: op, transform: `translateY(${y}px)` }}>
        <div style={{ fontFamily: INTER_TIGHT, fontWeight: 600, fontSize: 34 * k, color: "#F4F7FA", letterSpacing: "0.01em" }}>{titulo}</div>
        {sub && <div style={{ fontFamily: INTER, fontWeight: 400, fontSize: 22 * k, color: "#BFC7D5", marginTop: 4 * k }}>{sub}</div>}
      </div>
    </AbsoluteFill>
  );
};

// Overlays de B-roll repartidos sobre el bloque (mudos; el audio del spine sigue). Push lento, no por reloj rígido.
const Overlays: React.FC<{ broll: string[]; total: number }> = ({ broll, total }) => {
  const { fps } = useVideoConfig();
  const n = broll.length;
  if (!n) return null;
  const margen = Math.round(total * 0.18);
  const paso = (total - 2 * margen) / (n + 1);
  const dur = Math.round(4.2 * fps);
  return (
    <>
      {broll.map((bl, i) => {
        const start = Math.max(0, Math.round(margen + (i + 1) * paso - dur / 2));
        return (
          <Sequence key={i} from={start} durationInFrames={dur}>
            <Grade preset="A1">
              <PushSlow durFrames={dur} dir={i % 2 === 0 ? "in" : "out"}>
                <OffthreadVideo src={vidUrl(bl)} muted toneMapped={false} />
              </PushSlow>
            </Grade>
          </Sequence>
        );
      })}
    </>
  );
};

// Cold open (tráiler ≤45 s, sin revelar el desenlace del trade): cortes directos, B-roll con voz en
// off de las piezas, momentos a cámara. Fade solo al inicio y al final.
const ColdOpen: React.FC<{ frags: Frag[] }> = ({ frags }) => {
  const { fps } = useVideoConfig();
  const f = useCurrentFrame();
  const total = frags.reduce((s, x) => s + Math.round(x.dur * fps), 0);
  const fadeIn = interpolate(f, [0, 16], [0, 1], { extrapolateRight: "clamp" });
  const fadeOut = interpolate(f, [total - 14, total], [1, 0], { extrapolateLeft: "clamp" });
  let acc = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: "#05070A", opacity: Math.min(fadeIn, fadeOut) }}>
      {frags.map((fr, i) => {
        const dur = Math.round(fr.dur * fps);
        const from = acc;
        acc += dur;
        return (
          <Sequence key={i} from={from} durationInFrames={dur}>
            <Grade preset={fr.grade ?? "A1"}>
              <PushSlow durFrames={dur} dir={i % 2 === 0 ? "in" : "out"}>
                <OffthreadVideo src={vidUrl(fr.video)} trimBefore={Math.round((fr.from ?? 0) * fps)} muted={!fr.conAudio} toneMapped={false} />
              </PushSlow>
            </Grade>
            {fr.vo && (
              <Audio src={vidUrl(fr.vo.src)} trimBefore={Math.round(fr.vo.from * fps)} trimAfter={Math.round((fr.vo.from + fr.vo.dur) * fps)} />
            )}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

const Outro: React.FC<{ video?: string }> = ({ video }) => {
  const { fps, height } = useVideoConfig();
  const k = height / 1080;
  const f = useCurrentFrame();
  const dur = Math.round(8 * fps);
  const fadeOut = interpolate(f, [dur - 70, dur], [1, 0], { extrapolateLeft: "clamp" });
  const textOp = interpolate(f, [30, 56], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ backgroundColor: "#05070A" }}>
      {video && (
        <AbsoluteFill style={{ opacity: fadeOut }}>
          <Grade preset="A1">
            <PushSlow durFrames={dur} dir="out"><OffthreadVideo src={vidUrl(video)} muted toneMapped={false} /></PushSlow>
          </Grade>
        </AbsoluteFill>
      )}
      <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", opacity: textOp * fadeOut }}>
        <div style={{ marginBottom: 96 * k, fontFamily: INTER_TIGHT, color: "#F4F7FA", letterSpacing: "0.42em", fontSize: 26 * k, fontWeight: 600, paddingLeft: "0.42em", textShadow: `0 ${2 * k}px ${12 * k}px rgba(5,7,10,0.8)` }}>
          EL JUEGO REAL
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const TitleCard: React.FC = () => {
  const f = useCurrentFrame();
  const { height } = useVideoConfig();
  const k = height / 1080;
  const op = interpolate(f, [0, 14, 120, 140], [0, 1, 1, 0], { extrapolateRight: "clamp" });
  const y = interpolate(f, [0, 30], [16 * k, 0], { easing: APPLE, extrapolateRight: "clamp" });
  const lineW = interpolate(f, [18, 46], [0, 132 * k], { easing: APPLE, extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ backgroundColor: "#05070A", justifyContent: "center", alignItems: "center" }}>
      <div style={{ opacity: op, transform: `translateY(${y}px)`, textAlign: "center" }}>
        <div style={{ fontFamily: INTER_TIGHT, color: "#00E5FF", letterSpacing: "0.5em", fontSize: 28 * k, fontWeight: 600, paddingLeft: "0.5em", marginBottom: 22 * k }}>EL JUEGO REAL</div>
        <div style={{ fontFamily: INTER_TIGHT, color: "#F4F7FA", fontSize: 104 * k, fontWeight: 800, lineHeight: 0.98, letterSpacing: "-0.025em" }}>Trading desde<br />el cielo</div>
        <div style={{ width: lineW, height: 3 * k, background: "#00E5FF", margin: `${28 * k}px auto 0`, borderRadius: 3 }} />
      </div>
    </AbsoluteFill>
  );
};

export const bloqueDur = (b: Bloque, fps: number): number => {
  if (b.tipo === "habla" || b.tipo === "trading") return Math.max(1, Math.round((b.dur ?? 1) * fps));
  if (b.tipo === "title_card") return Math.round(2.5 * fps);
  if (b.tipo === "cold_open") return (b.frags ?? []).reduce((s, fr) => s + Math.round(fr.dur * fps), 0) || Math.round(6 * fps);
  if (b.tipo === "outro") return Math.round(8 * fps);
  return fps;
};

export const Vlog: React.FC<VlogProps> = ({ fps, bloques }) => {
  let acc = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {bloques.map((b, i) => {
        const dur = bloqueDur(b, fps);
        const from = acc;
        acc += dur;
        let inner: React.ReactNode;
        if (b.tipo === "habla")
          inner = (
            <>
              <Grade preset={b.grade ?? "C1"}>
                <PunchCut captions={b.captions}>
                  <OffthreadVideo src={vidUrl(b.video!)} toneMapped={false} />
                </PunchCut>
              </Grade>
              {b.broll && <Overlays broll={b.broll} total={dur} />}
              {b.captions && <Subs captions={b.captions} />}
            </>
          );
        else if (b.tipo === "trading")
          inner = (
            <>
              <Grade preset={b.grade ?? "B1"}>
                <PanZoomChart durFrames={dur}>
                  <OffthreadVideo src={vidUrl(b.video!)} toneMapped={false} />
                </PanZoomChart>
              </Grade>
              {b.captions && <Subs captions={b.captions} />}
            </>
          );
        else if (b.tipo === "title_card") inner = <TitleCard />;
        else if (b.tipo === "cold_open") inner = <ColdOpen frags={b.frags ?? []} />;
        else inner = <Outro video={b.video} />;
        return (
          <Sequence key={i} from={from} durationInFrames={dur}>
            {inner}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

export const calcVlog: CalculateMetadataFunction<VlogProps> = async () => {
  const plan = await fetch(staticFile("render_plan.json")).then((r) => r.json());
  const caps: Record<string, Caption[]> = await fetch(staticFile("china/subs/captions.json"))
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  const fps: number = plan.fps ?? 60;
  const bloques: Bloque[] = (plan.bloques ?? []).map((b: Bloque) => {
    if (!b.video) return b;
    const stem = b.video.split("/").pop()!.replace(/\.mp4$/, "");
    return { ...b, captions: caps[stem] ?? [] };
  });
  const total = bloques.reduce((s: number, b: Bloque) => s + bloqueDur(b, fps), 0);
  return { durationInFrames: Math.max(fps, total), fps, props: { fps, bloques } };
};
