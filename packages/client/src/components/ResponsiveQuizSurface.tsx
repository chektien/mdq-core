import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { type FitDensity, type FitRoom, initialFitState, stepFit } from "../quizFit";

function getAvailableRoom(element: HTMLElement): FitRoom {
  const safeArea = element.closest(".slide-safe") as HTMLElement | null;
  const container = safeArea || element.parentElement;
  if (!container) return { width: window.innerWidth, height: window.innerHeight };

  const styles = window.getComputedStyle(container);
  const paddingY = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
  const rect = container.getBoundingClientRect();
  const visibleHeight = Math.min(container.clientHeight, rect.height, window.innerHeight - Math.max(0, rect.top));
  return { width: container.clientWidth, height: Math.max(240, visibleHeight - paddingY) };
}

/** Whether a DOM change can alter the content's height. The timer's ring and count change every second and never do. */
function mayChangeFit(record: MutationRecord, element: HTMLElement): boolean {
  // The fit writes its own height to the element's style.
  if (record.type === "attributes" && record.target === element && record.attributeName === "style") return false;
  const target = record.target instanceof Element ? record.target : record.target.parentElement;
  return !target?.closest("[data-fit-ignore]");
}

const LAYOUT_PROPERTY = /^(gap|row-gap|column-gap|margin|padding|font-size|line-height)/;

/** The transitions under the element that are still moving something in its layout, such as the gap a new density eases to. */
function layoutTransitions(element: HTMLElement): Animation[] {
  if (typeof element.getAnimations !== "function") return [];
  return element.getAnimations({ subtree: true }).filter((animation) => {
    const { transitionProperty } = animation as Partial<CSSTransition>;
    if (!transitionProperty || !LAYOUT_PROPERTY.test(transitionProperty)) return false;
    const target = (animation.effect as KeyframeEffect | null)?.target;
    return !target?.closest("[data-fit-ignore]");
  });
}

export default function ResponsiveQuizSurface({
  children,
  reveal = false,
  leaderboard = false,
  fitKey = "",
}: {
  children: ReactNode;
  reveal?: boolean;
  leaderboard?: boolean;
  /** Names what the screen shows, such as the question and its state. When it changes the fit forgets which densities overflowed. */
  fitKey?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const fitRef = useRef(initialFitState(fitKey));
  const [density, setDensity] = useState<FitDensity>("comfortable");

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || leaderboard) return undefined;

    let frame = 0;
    let active = true;

    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // A density that has just been set is still easing its gaps in. Measure once it has arrived.
        const moving = layoutTransitions(element);
        if (moving.length > 0) {
          void Promise.allSettled(moving.map((animation) => animation.finished)).then(() => { if (active) measure(); });
          return;
        }
        const room = getAvailableRoom(element);
        const overflowRatio = element.scrollHeight / room.height;
        // The scaled density shrinks the content with a transform, which keeps its
        // layout height. The stylesheet trims the margins by this height.
        const layoutHeight = `${element.offsetHeight}px`;
        if (element.style.getPropertyValue("--quiz-fit-height") !== layoutHeight) element.style.setProperty("--quiz-fit-height", layoutHeight);

        fitRef.current = stepFit(fitRef.current, { ratio: overflowRatio, room, contentKey: fitKey });
        setDensity(fitRef.current.density);
      });
    };

    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(element);

    const safeArea = element.closest(".slide-safe");
    if (safeArea) resizeObserver.observe(safeArea);

    const mutationObserver = new MutationObserver((records) => {
      if (records.some((record) => mayChangeFit(record, element))) measure();
    });
    mutationObserver.observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });

    measure();

    return () => {
      active = false;
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [leaderboard, fitKey]);

  return (
    <div
      ref={ref}
      className={[
        "quiz-surface-content",
        "quiz-surface-content-fit",
        reveal ? "quiz-surface-content-reveal" : "",
        leaderboard ? "quiz-surface-content-leaderboard" : "",
        // A question screen shows its options or result bars, which the join card must not cover.
        !reveal && !leaderboard ? "quiz-surface-content-options" : "",
      ].filter(Boolean).join(" ")}
      data-fit-density={leaderboard ? undefined : density}
    >
      {children}
    </div>
  );
}
