import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, interpolate } from "remotion";
import { C, sans, mono } from "./theme";
import {
  Bg,
  Caption,
  Chip,
  PhoneFrame,
  ScreenFrame,
  Spotlight,
  fade,
  rise,
  useSpringIn,
} from "./ui";

// ── scene fade wrapper (dip-to-background cross dissolve) ────────
const Scene: React.FC<{ dur: number; children: React.ReactNode; style?: React.CSSProperties }> = ({
  dur,
  children,
  style,
}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 12, dur - 14, dur], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ opacity, ...style }}>{children}</AbsoluteFill>
  );
};

const Center: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", ...style }}>{children}</AbsoluteFill>
);

// ── logo ────────────────────────────────────────────────────────
const Logo: React.FC<{ scale?: number }> = ({ scale = 1 }) => {
  const s = useSpringIn(4);
  const frame = useCurrentFrame();
  const underline = interpolate(frame, [16, 40], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, transform: `scale(${(0.9 + 0.1 * s) * scale})` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
        <div
          style={{
            width: 96,
            height: 96,
            borderRadius: 24,
            background: `linear-gradient(150deg, ${C.accentHi}, ${C.accent})`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 24px 60px -20px rgba(179,102,255,0.8)",
            transform: `rotate(${interpolate(s, [0, 1], [-8, 0])}deg)`,
          }}
        >
          <span style={{ fontFamily: mono, fontWeight: 500, fontSize: 58, color: "#220f33", marginTop: -6 }}>↓</span>
        </div>
        <div style={{ fontFamily: sans, fontWeight: 700, fontSize: 132, letterSpacing: -4, color: C.ink, lineHeight: 1 }}>
          mdq
        </div>
      </div>
      <div style={{ height: 4, width: 360 * underline, background: `linear-gradient(90deg, ${C.accent}, transparent)`, borderRadius: 2 }} />
    </div>
  );
};

// ── 1. intro ────────────────────────────────────────────────────
const SceneIntro: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  return (
    <Scene dur={dur}>
      <Center>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 34 }}>
          <Logo />
          <div
            style={{
              fontFamily: sans,
              fontWeight: 500,
              fontSize: 30,
              letterSpacing: 0.5,
              color: C.muted,
              opacity: fade(frame, 28),
              transform: `translateY(${rise(frame, 28, 18, 18)}px)`,
            }}
          >
            Markdown decks, questions & live presentations
          </div>
        </div>
      </Center>
    </Scene>
  );
};

// ── markdown card for premise ───────────────────────────────────
const MD_LINES: { t: string; c: string; ind?: number }[] = [
  { t: "## Smoke Test Overview", c: C.accentHi },
  { t: "", c: C.ink },
  { t: "type: slide", c: C.soft },
  { t: "", c: C.ink },
  { t: "- Confirm the instructor, student", c: C.ink },
  { t: "  and projector are connected.", c: C.ink, ind: 1 },
  { t: "  > Attendee Note: public smoke", c: C.greenInk },
  { t: "  > test for fold-out notes.", c: C.greenInk, ind: 1 },
  { t: "", c: C.ink },
  { t: "![](smoke-diagram.svg)", c: C.accent },
];

const MarkdownCard: React.FC<{ start: number }> = ({ start }) => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        width: 660,
        background: "rgba(20,20,19,0.92)",
        border: `1px solid ${C.line}`,
        borderRadius: 18,
        boxShadow: "0 40px 90px -34px rgba(0,0,0,0.9)",
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "16px 20px", borderBottom: `1px solid ${C.line}` }}>
        <span style={{ width: 13, height: 13, borderRadius: 99, background: "#ff5f57" }} />
        <span style={{ width: 13, height: 13, borderRadius: 99, background: "#febc2e" }} />
        <span style={{ width: 13, height: 13, borderRadius: 99, background: "#28c840" }} />
        <span style={{ fontFamily: mono, fontSize: 16, color: C.soft, marginLeft: 12 }}>week00.md</span>
      </div>
      <div style={{ padding: "26px 30px", display: "flex", flexDirection: "column", gap: 2 }}>
        {MD_LINES.map((ln, i) => {
          const o = fade(frame, start + i * 5, 8);
          return (
            <div
              key={i}
              style={{
                fontFamily: mono,
                fontSize: 24,
                lineHeight: 1.5,
                color: ln.c,
                opacity: o,
                minHeight: 18,
                whiteSpace: "pre",
              }}
            >
              {ln.t}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ── 2. premise: markdown → live ─────────────────────────────────
const ScenePremise: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const slideIn = fade(frame, 92, 18);
  return (
    <Scene dur={dur}>
      <AbsoluteFill style={{ padding: "0 110px", alignItems: "center", justifyContent: "center" }}>
        <div style={{ position: "absolute", top: 96, left: 110 }}>
          <Caption eyebrow="Markdown-first" title={<>One file drives<br />the whole room.</>} start={4} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 56, marginTop: 130 }}>
          <div style={{ transform: `translateX(${rise(frame, 30, 22, -30)}px)`, opacity: fade(frame, 30) }}>
            <MarkdownCard start={36} />
          </div>
          <div
            style={{
              fontFamily: sans,
              fontSize: 56,
              color: C.accent,
              opacity: fade(frame, 86),
              transform: `scale(${interpolate(fade(frame, 86), [0, 1], [0.6, 1])})`,
            }}
          >
            →
          </div>
          <div style={{ width: 720, opacity: slideIn, transform: `translateX(${interpolate(slideIn, [0, 1], [40, 0])}px) scale(${interpolate(slideIn, [0, 1], [0.96, 1])})` }}>
            <ScreenFrame src="projector-slide" label="PROJECTOR" />
          </div>
        </div>
      </AbsoluteFill>
    </Scene>
  );
};

// ── 3. slides + fold-out notes ──────────────────────────────────
const SceneSlide: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const sc = fade(frame, 10, 20);
  return (
    <Scene dur={dur}>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: 1180, position: "relative", transform: `scale(${interpolate(sc, [0, 1], [0.97, 1])})`, opacity: sc }}>
          <ScreenFrame src="projector-slide" label="SLIDE" />
          <Spotlight rect={[0.05, 0.81, 0.9, 0.13]} start={48} tone={C.green} />
        </div>
      </AbsoluteFill>
      <div style={{ position: "absolute", top: 70, left: 90 }}>
        <Caption eyebrow="Slides" title="Sparse slides, rich notes" start={6} style={{ maxWidth: 560 }} />
      </div>
      <div style={{ position: "absolute", bottom: 78, left: 90, display: "flex", gap: 16 }}>
        <Chip start={40}>Markdown headings & bullets</Chip>
        <Chip start={52} tone="green">Fold-out presenter &amp; attendee notes</Chip>
      </div>
    </Scene>
  );
};

// ── 4. live quiz + reveal ───────────────────────────────────────
const SceneQuiz: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  // question card crossfades into reveal card
  const qOut = interpolate(frame, [70, 92], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const rIn = fade(frame, 78, 20);
  return (
    <Scene dur={dur}>
      <div style={{ position: "absolute", top: 64, left: 90, zIndex: 5 }}>
        <Caption eyebrow="Live quizzing" title="Ask. Answer. Reveal." start={6} style={{ maxWidth: 540 }} />
      </div>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div style={{ position: "relative", width: 1120, marginTop: 60 }}>
          <div style={{ position: "absolute", inset: 0, opacity: qOut }}>
            <ScreenFrame src="projector-question" label="QUESTION OPEN" />
          </div>
          <div style={{ opacity: rIn, transform: `scale(${interpolate(rIn, [0, 1], [0.98, 1])})` }}>
            <ScreenFrame src="projector-reveal" label="REVEAL" />
            <Spotlight rect={[0.225, 0.44, 0.55, 0.115]} start={96} tone={C.green} />
          </div>
        </div>
      </AbsoluteFill>
      <div style={{ position: "absolute", bottom: 74, right: 90, display: "flex", gap: 16 }}>
        <Chip start={104} tone="green">Correct answer highlighted</Chip>
        <Chip start={116}>Real-time distribution</Chip>
      </div>
    </Scene>
  );
};

// ── 5. polls + open responses ───────────────────────────────────
const ScenePolls: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  return (
    <Scene dur={dur}>
      <div style={{ position: "absolute", top: 70, left: 0, right: 0, display: "flex", justifyContent: "center" }}>
        <Caption eyebrow="More question types" title="Polls and open responses" sub="All from the same markdown deck — no exports, no other tools." start={6} align="center" />
      </div>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", marginTop: 90 }}>
        <div style={{ display: "flex", gap: 46 }}>
          <div style={{ width: 760, opacity: fade(frame, 30), transform: `translateY(${rise(frame, 30, 22, 36)}px)` }}>
            <ScreenFrame src="projector-poll" label="POLL" />
          </div>
          <div style={{ width: 760, opacity: fade(frame, 46), transform: `translateY(${rise(frame, 46, 22, 36)}px)` }}>
            <ScreenFrame src="projector-open-response" label="OPEN RESPONSE" />
          </div>
        </div>
      </AbsoluteFill>
    </Scene>
  );
};

// ── 6. three surfaces ───────────────────────────────────────────
const SceneSurfaces: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  return (
    <Scene dur={dur}>
      <div style={{ position: "absolute", top: 60, left: 0, right: 0, display: "flex", justifyContent: "center", zIndex: 6 }}>
        <Caption eyebrow="One session, three views" title="Instructor. Projector. Every phone." start={6} align="center" />
      </div>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", marginTop: 70 }}>
        <div style={{ position: "relative", width: 1500, height: 720 }}>
          {/* instructor back-left */}
          <div style={{ position: "absolute", left: 0, top: 120, width: 720, opacity: fade(frame, 26), transform: `translateX(${rise(frame, 26, 24, -50)}px) rotate(-3deg)` }}>
            <ScreenFrame src="instructor-live" label="INSTRUCTOR" />
          </div>
          {/* projector back-right */}
          <div style={{ position: "absolute", right: 0, top: 70, width: 820, opacity: fade(frame, 40), transform: `translateX(${rise(frame, 40, 24, 50)}px) rotate(3deg)` }}>
            <ScreenFrame src="projector-lobby" label="PROJECTOR" />
          </div>
          {/* phone front-center */}
          <div style={{ position: "absolute", left: 620, top: 60, width: 290, opacity: fade(frame, 56), transform: `translateY(${rise(frame, 56, 24, 60)}px)`, zIndex: 4 }}>
            <PhoneFrame src="student-question" />
          </div>
        </div>
      </AbsoluteFill>
      <div style={{ position: "absolute", bottom: 70, left: 0, right: 0, display: "flex", justifyContent: "center" }}>
        <Chip start={86}>Scan the code, join on any device — no install</Chip>
      </div>
    </Scene>
  );
};

// ── 7. images / media ───────────────────────────────────────────
const SceneImage: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const sc = fade(frame, 10, 20);
  return (
    <Scene dur={dur}>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: 1150, position: "relative", opacity: sc, transform: `scale(${interpolate(sc, [0, 1], [0.97, 1])})` }}>
          <ScreenFrame src="projector-image" label="IMAGE" />
          <Spotlight rect={[0.32, 0.27, 0.36, 0.34]} start={46} />
        </div>
      </AbsoluteFill>
      <div style={{ position: "absolute", top: 70, right: 90, textAlign: "right" }}>
        <Caption eyebrow="Media" title={<>Images render<br />inline</>} start={6} align="left" style={{ alignItems: "flex-end", textAlign: "right" }} />
      </div>
      <div style={{ position: "absolute", bottom: 78, left: 90, display: "flex", gap: 16 }}>
        <Chip start={40}>Diagrams, photos &amp; figures on slides and questions</Chip>
      </div>
    </Scene>
  );
};

// ── 8. leaderboard ──────────────────────────────────────────────
const SceneLeaderboard: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const sc = fade(frame, 10, 20);
  return (
    <Scene dur={dur}>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: 1080, opacity: sc, transform: `translateY(${rise(frame, 10, 22, 30)}px) scale(${interpolate(sc, [0, 1], [0.97, 1])})` }}>
          <ScreenFrame src="projector-leaderboard" label="LEADERBOARD" />
        </div>
      </AbsoluteFill>
      <div style={{ position: "absolute", top: 80, left: 90 }}>
        <Caption eyebrow="Results" title={<>Score it.<br />Crown it.</>} start={6} />
      </div>
    </Scene>
  );
};

// ── 9. outro ────────────────────────────────────────────────────
const SceneOutro: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  return (
    <Scene dur={dur}>
      <Center>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 30 }}>
          <Logo />
          <div
            style={{
              fontFamily: sans,
              fontWeight: 500,
              fontSize: 27,
              color: C.muted,
              opacity: fade(frame, 26),
              transform: `translateY(${rise(frame, 26, 18, 16)}px)`,
            }}
          >
            Markdown in. A live class out.
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              opacity: fade(frame, 40),
              transform: `translateY(${rise(frame, 40, 18, 16)}px)`,
            }}
          >
            <span style={{ fontFamily: mono, fontSize: 22, color: C.accentInk, background: "rgba(179,102,255,0.16)", border: `1px solid ${C.line}`, padding: "7px 16px", borderRadius: 999 }}>
              v0.3.1-beta
            </span>
          </div>
          <div
            style={{
              marginTop: 26,
              fontFamily: sans,
              fontSize: 18,
              letterSpacing: 0.4,
              color: C.soft,
              textAlign: "center",
              lineHeight: 1.7,
              opacity: fade(frame, 58),
            }}
          >
            <div style={{ textTransform: "uppercase", letterSpacing: 3, fontSize: 14, color: C.soft, marginBottom: 8 }}>Credits</div>
            Image positioning &middot; Leon Foo &nbsp;·&nbsp; PR&nbsp;#33
          </div>
        </div>
      </Center>
    </Scene>
  );
};

// ── assembly ────────────────────────────────────────────────────
const SCENES: { C: React.FC<{ dur: number }>; d: number }[] = [
  { C: SceneIntro, d: 110 },
  { C: ScenePremise, d: 250 },
  { C: SceneSlide, d: 240 },
  { C: SceneQuiz, d: 280 },
  { C: ScenePolls, d: 250 },
  { C: SceneSurfaces, d: 300 },
  { C: SceneImage, d: 230 },
  { C: SceneLeaderboard, d: 220 },
  { C: SceneOutro, d: 280 },
];

export const TOTAL = SCENES.reduce((a, s) => a + s.d, 0);

export const MdqDemo: React.FC = () => {
  let at = 0;
  return (
    <AbsoluteFill>
      <Bg />
      {SCENES.map((s, i) => {
        const from = at;
        at += s.d;
        const Comp = s.C;
        return (
          <Sequence key={i} from={from} durationInFrames={s.d}>
            <Comp dur={s.d} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
