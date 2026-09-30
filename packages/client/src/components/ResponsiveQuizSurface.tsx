import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

type FitDensity = "comfortable" | "compact" | "tight" | "scaled";

const DENSITY_ORDER: FitDensity[] = ["comfortable", "compact", "tight", "scaled"];

function nextDensity(current: FitDensity): FitDensity {
  return DENSITY_ORDER[Math.min(DENSITY_ORDER.indexOf(current) + 1, DENSITY_ORDER.length - 1)];
}

function previousDensity(current: FitDensity): FitDensity {
  return DENSITY_ORDER[Math.max(DENSITY_ORDER.indexOf(current) - 1, 0)];
}

function getAvailableHeight(element: HTMLElement): number {
  const safeArea = element.closest(".slide-safe") as HTMLElement | null;
  const container = safeArea || element.parentElement;
  if (!container) return window.innerHeight;

  const styles = window.getComputedStyle(container);
  const paddingY = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
  const rect = container.getBoundingClientRect();
  const visibleHeight = Math.min(container.clientHeight, rect.height, window.innerHeight - Math.max(0, rect.top));
  return Math.max(240, visibleHeight - paddingY);
}

export default function ResponsiveQuizSurface({
  children,
  reveal = false,
  leaderboard = false,
  answering = false,
}: {
  children: ReactNode;
  reveal?: boolean;
  leaderboard?: boolean;
  /** True while the answer options are shown as a grid to choose from (not as results), so the stylesheet keeps the join card clear of them. */
  answering?: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [density, setDensity] = useState<FitDensity>("comfortable");

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || leaderboard) return undefined;

    let frame = 0;

    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const available = getAvailableHeight(element);
        const contentHeight = element.scrollHeight;
        const overflowRatio = contentHeight / available;
        // The scaled density shrinks the content with a transform, which keeps its
        // layout height. The stylesheet trims the margins by this height.
        const layoutHeight = `${element.offsetHeight}px`;
        if (element.style.getPropertyValue("--quiz-fit-height") !== layoutHeight) element.style.setProperty("--quiz-fit-height", layoutHeight);

        setDensity((current) => {
          if (overflowRatio > 1) return nextDensity(current);
          if (overflowRatio < 0.78) return previousDensity(current);
          return current;
        });
      });
    };

    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(element);

    const safeArea = element.closest(".slide-safe");
    if (safeArea) resizeObserver.observe(safeArea);

    const mutationObserver = new MutationObserver(measure);
    mutationObserver.observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });

    measure();

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [leaderboard]);

  return (
    <div
      ref={ref}
      className={[
        "quiz-surface-content",
        "quiz-surface-content-fit",
        reveal ? "quiz-surface-content-reveal" : "",
        leaderboard ? "quiz-surface-content-leaderboard" : "",
        answering ? "quiz-surface-content-answering" : "",
      ].filter(Boolean).join(" ")}
      data-fit-density={leaderboard ? undefined : density}
    >
      {children}
    </div>
  );
}
