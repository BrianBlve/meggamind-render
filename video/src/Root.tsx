import { Composition, staticFile } from "remotion";
import { DEMO, DEMO_CAPTIONS } from "./demo";
import { OverlaySerie, OverlayProps } from "./OverlaySerie";
import { Subtitulos, SubtitulosProps } from "./Subtitulos";
import { Vlog, calcVlog, VlogProps } from "./Vlog";
import { Reel, ReelProps } from "./Reel";
import { FPS } from "./theme";

// La duración del overlay se ajusta al último evento (lo usa el render real).
const calcOverlay = ({ props }: { props: OverlayProps }) => {
  const last = props.eventos.reduce(
    (m, e) => Math.max(m, (e.segundo ?? 0) + (e.duracion ?? 1)),
    0,
  );
  return { durationInFrames: Math.max(FPS, Math.round((last + 1) * FPS)), fps: FPS };
};

// La duración de los subtítulos se ajusta al último caption.
const calcSubs = ({ props }: { props: SubtitulosProps }) => {
  const last = props.captions.reduce((m, c) => Math.max(m, c.endMs), 0);
  return { durationInFrames: Math.max(FPS, Math.round((last / 1000 + 0.5) * FPS)), fps: FPS };
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="OverlayVertical"
        component={OverlaySerie}
        fps={FPS}
        width={1080}
        height={1920}
        durationInFrames={300}
        defaultProps={{ formato: "reel", eventos: DEMO } as OverlayProps}
        calculateMetadata={calcOverlay}
      />
      <Composition
        id="OverlayHorizontal"
        component={OverlaySerie}
        fps={FPS}
        width={1920}
        height={1080}
        durationInFrames={300}
        defaultProps={{ formato: "youtube", eventos: DEMO } as OverlayProps}
        calculateMetadata={calcOverlay}
      />
      <Composition
        id="SubtitulosVertical"
        component={Subtitulos}
        fps={FPS}
        width={1080}
        height={1920}
        durationInFrames={180}
        defaultProps={{ formato: "reel", captions: DEMO_CAPTIONS } as SubtitulosProps}
        calculateMetadata={calcSubs}
      />
      <Composition
        id="SubtitulosHorizontal"
        component={Subtitulos}
        fps={FPS}
        width={1920}
        height={1080}
        durationInFrames={180}
        defaultProps={{ formato: "youtube", captions: DEMO_CAPTIONS } as SubtitulosProps}
        calculateMetadata={calcSubs}
      />
      {/* Máster: lee render_plan.json. modo "proxy" (1080p, preview fluido) o "4k" (horneo en la nube).
          calcVlog fija dimensiones/duración/props desde el plan. Los textos escalan con k = height/1080. */}
      <Composition
        id="Vlog"
        component={Vlog}
        fps={60}
        width={3840}
        height={2160}
        durationInFrames={300}
        defaultProps={{ plan: { fps: 60, modo: "4k", fuentes: {}, timeline: [] }, subs: [] } as VlogProps}
        calculateMetadata={calcVlog}
      />
      {/* Reel vertical de prueba (gate end-to-end): canvas 1080x1920, render con --scale=2. */}
      <Composition
        id="Reel"
        component={Reel}
        fps={60}
        width={1080}
        height={1920}
        durationInFrames={600}
        defaultProps={{
          src: "reel/base_sdr_10s.mp4",
          captions: [
            { text: "prueba end-to-end del pipeline", startMs: 800, endMs: 4200, keyword: "pipeline" },
            { text: "vertical 4K desde Remotion", startMs: 4600, endMs: 9200, keyword: "4K" },
          ],
        } as ReelProps}
      />
    </>
  );
};
