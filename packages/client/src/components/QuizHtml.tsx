import {
  memo,
  type Ref,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { type ExpandedImage, ImageExpansionOverlay } from "./ImageExpansion";
import { openLinksInNewTab } from "../slideLinks";

function findImageTarget(target: EventTarget | null, container: HTMLElement): HTMLImageElement | null {
  if (!(target instanceof Element)) return null;
  const image = target.closest("img");
  return image instanceof HTMLImageElement && container.contains(image) ? image : null;
}

function getImageLabel(image: HTMLImageElement): string {
  return image.getAttribute("title") || image.getAttribute("alt") || "image";
}

function QuizHtml({
  html,
  className,
  id,
  as = "div",
}: {
  html: string;
  className: string;
  id?: string;
  as?: "div" | "span";
}) {
  const containerRef = useRef<HTMLElement | null>(null);
  const lastTriggerSrcRef = useRef<string | null>(null);
  const lastTriggerElementRef = useRef<HTMLImageElement | null>(null);
  const [expandedImage, setExpandedImage] = useState<ExpandedImage | null>(null);

  const closeExpandedImage = useCallback(() => {
    setExpandedImage(null);
    window.setTimeout(() => lastTriggerElementRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const images = Array.from(container.querySelectorAll("img"));
    for (const image of images) {
      const label = getImageLabel(image);
      image.classList.add("image-expandable-inline");
      image.setAttribute("role", "button");
      image.setAttribute("tabindex", image.getAttribute("tabindex") || "0");
      image.setAttribute("aria-label", `Expand ${label}`);
    }

    // A link tap must not replace the session page, so web links open in a new tab.
    openLinksInNewTab(container.querySelectorAll("a[href]"), document.baseURI);

    const openImage = (image: HTMLImageElement) => {
      lastTriggerSrcRef.current = image.currentSrc || image.src;
      lastTriggerElementRef.current = image;
      setExpandedImage({
        src: image.currentSrc || image.src,
        alt: image.getAttribute("alt") || "",
        title: image.getAttribute("title") || image.getAttribute("alt") || undefined,
      });
    };

    const onClick = (event: MouseEvent) => {
      const image = findImageTarget(event.target, container);
      if (!image) return;
      event.preventDefault();
      event.stopPropagation();
      openImage(image);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const image = findImageTarget(event.target, container);
      if (!image) return;
      event.preventDefault();
      event.stopPropagation();
      openImage(image);
    };

    container.addEventListener("click", onClick);
    container.addEventListener("keydown", onKeyDown);

    return () => {
      container.removeEventListener("click", onClick);
      container.removeEventListener("keydown", onKeyDown);
    };
  }, [html]);

  const htmlProps = {
    id,
    className,
    dangerouslySetInnerHTML: { __html: html },
  };

  return (
    <>
      {as === "span" ? (
        <span ref={containerRef as Ref<HTMLSpanElement>} {...htmlProps} />
      ) : (
        <div ref={containerRef as Ref<HTMLDivElement>} {...htmlProps} />
      )}
      <ImageExpansionOverlay image={expandedImage} onClose={closeExpandedImage} />
    </>
  );
}

export default memo(QuizHtml);
