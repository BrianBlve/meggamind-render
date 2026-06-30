// Esquema del render_plan.json: el EDL editable del protocolo de producción.
// Brian da órdenes ("corta el blooper de 0:12 a 0:18"); el agente edita SOLO las líneas afectadas
// de este plan. La composición Vlog lee este plan y renderiza todo. Tiempos en SEGUNDOS.

export type Grade = "A1" | "A2" | "A3" | "B1" | "B2" | "B3" | "C1" | "C2" | "C3";

export type Rango = { from: number; to: number };

// --- Los 4 tipos de zoom del protocolo (Bloque F) ---
export type Zoom =
  // Tipo 1: punch-in por CORTE (talking head). En [from,to] salta a B(~115-120%) por corte seco, sin animar.
  | { tipo: "punch"; from: number; to: number; magnitud?: number }
  // Tipo 2: push lento (planos largos de naturaleza). Se omite si pixela.
  | { tipo: "push"; from: number; to: number; dir?: "in" | "out" }
  // Tipo 3: pan-zoom narrativo de chart. Recorre el gráfico siguiendo la voz. de/a = escala inicial/final.
  | { tipo: "panzoom"; from: number; to: number; origenX?: number; origenY?: number; de?: number; a?: number }
  // Tipo 4: énfasis puntual (revelación). Máx 4-5 en todo el video.
  | { tipo: "enfasis"; from: number; to: number; magnitud?: number };

// B-roll como cutaway: el audio del spine sigue por debajo (B2). ambiente=true sube el sonido del clip (B4).
export type Broll = { clip: string; at: number; dur: number; grade?: Grade; ambiente?: boolean };

// Lower third de ubicación (C10): línea principal + secundaria tenue.
export type LowerThird = { titulo: string; sub?: string; at: number; dur: number };

// Chip de dato de trading (C10): target / resultado sobre el chart, sincronizado con su mención.
// verde=true para resaltar ganancia (p.ej. "+$500").
export type Chip = { label: string; valor: string; at: number; dur: number; x?: number; y?: number; verde?: boolean };

// Clip vertical insertado (B5). 5 formas según el caso (ver memoria formas-contenido-vertical):
// panel (a un tercio + texto al lado), duo (dos 9:16 con gap 24px), centrado (centrado con aire),
// punch16 (recortado a 16:9), marco (fondo oscuro de marca sólido). Default: marco.
export type FormaVertical = "panel" | "duo" | "centrado" | "punch16" | "marco";
export type Vertical = { clip: string; at: number; dur: number; forma?: FormaVertical; texto?: { titulo: string; sub?: string }; clip2?: string };

// Una toma del montage (interludio de B-roll sin voz, con música): clip + duración + grade.
export type ClipMontage = { clip: string; dur: number; grade?: Grade; ambiente?: boolean };

// Un bloque del timeline = un tramo continuo del video final.
export type Bloque = {
  tipo: "cold_open" | "title_card" | "habla" | "trading" | "outro" | "montage" | "trailer";
  fuente?: string;          // clave en plan.fuentes (p.ej. "vlog" o "trading")
  from?: number;            // inicio dentro de la fuente (s)
  dur?: number;             // duración del bloque (s)
  grade?: Grade;            // look por categoría (Bloque E)
  bloopers?: Rango[];       // rangos a SALTAR dentro del bloque (B1), relativos al bloque
  zoom?: Zoom[];            // zooms del bloque (relativos al bloque)
  broll?: Broll[];          // cutaways (relativos al bloque)
  cortes?: { src: string; at: number; in: number; dur: number }[]; // edicion nativa por cortes
  lowerThirds?: LowerThird[];
  chips?: Chip[];
  vertical?: Vertical[];
  clips?: ClipMontage[];    // solo montage: secuencia de tomas sin voz, con crossfade
  frags?: { video: string; from?: number; dur: number; conAudio?: boolean; vo?: { src: string; from: number; dur: number }; grade?: Grade }[]; // solo cold_open
};

export type Musica = { pieza: string; from: number; to: number; db?: number };  // C7/C8
export type SFX = { clip: string; at: number; db?: number };                    // C3
// C2 — transición entre escenas. "impacto" = dip rápido a negro + destello cian de marca que barre
// + whoosh. fuerza: "fuerte" (cambio de capítulo, negro pleno) / "rapido" (corte interno, más sutil).
export type Transicion = { tipo: "dip_black" | "impacto" | "whip"; at: number; dur?: number; fuerza?: "fuerte" | "rapido"; whoosh?: boolean };

export type RenderPlan = {
  fps: number;
  // "proxy" = preview 1080p fluido en la Mac; "4k" = horneo final en la nube.
  modo: "proxy" | "4k";
  // soloGraficos=true: render SOLO de las capas gráficas (subs, chips, lower-thirds, transiciones)
  // sobre fondo TRANSPARENTE, sin el video de fondo ni audio. Para el pipeline HDR: el cuerpo va en
  // HDR por ffmpeg y esta capa alpha se compone encima. El video HDR no pasa por Chrome (que es SDR).
  soloGraficos?: boolean;
  // Cada fuente con su versión nítida (conform de crudos) y su proxy 1080p.
  fuentes: Record<string, { full: string; proxy: string }>;
  timeline: Bloque[];
  audio?: string;        // pista de audio global mezclada (música+voz+SFX) en china/<audio>
  musica?: Musica[];
  sfx?: SFX[];
  transiciones?: Transicion[];
};

// Resolución del canvas según el modo (proxy 1080p / 4k 2160p). La fuente 4K sobre timeline 1080p
// da nitidez y headroom de zoom; el 4K final usa el canvas completo.
export const CANVAS = {
  proxy: { width: 1280, height: 720 },   // preview liviano para la Mac 2018 (decodifica/compone menos)
  "4k": { width: 3840, height: 2160 },
} as const;
