import { AbsoluteFill, OffthreadVideo, staticFile } from "remotion";
import { Subtitulos, Caption } from "./Subtitulos";

// Reel vertical (canvas 1080×1920, se renderiza con --scale=2 → 2160×3840).
// El cuerpo es UN clip ya editado (SDR bt709); Remotion pinta el video + los gráficos.
// toneMapped={false} SIEMPRE (regla del vlog 1: Chromium no debe re-tonemapear fuentes).
export type ReelProps = {
  src: string;
  captions: Caption[];
};

export const Reel: React.FC<ReelProps> = ({ src, captions }) => (
  <AbsoluteFill style={{ backgroundColor: "#05070A" }}>
    <OffthreadVideo
      src={staticFile(src)}
      toneMapped={false}
      style={{ width: "100%", height: "100%", objectFit: "cover" }}
    />
    <Subtitulos formato="reel" captions={captions} />
  </AbsoluteFill>
);
