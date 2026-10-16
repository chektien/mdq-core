import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export interface ExpandedImage {
  src: string;
  alt?: string;
  title?: string;
}

interface ImageExpansionOverlayProps {
  image: ExpandedImage | null;
  onClose: () => void;
}

interface ExpandableImageProps extends ExpandedImage {
  className?: string;
  children?: ReactNode;
}

function getImageName(image: ExpandedImage): string {
  return image.title || image.alt || "image";
}

export function ImageExpansionOverlay({ image, onClose }: ImageExpansionOverlayProps) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLElement | null>(null);
  const captionRef = useRef<HTMLElement | null>(null);
  const [imageWidth, setImageWidth] = useState<number | null>(null);

  useEffect(() => {
    setNaturalSize(null);
    setImageWidth(null);
  }, [image?.src]);

  useEffect(() => {
    if (!image) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    document.body.classList.add("image-expansion-lock");
    document.addEventListener("keydown", onKeyDown);
    window.setTimeout(() => closeButtonRef.current?.focus(), 0);

    return () => {
      document.body.classList.remove("image-expansion-lock");
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [image, onClose]);

  // Use the actual frame chrome and wrapped caption, not a guessed viewport
  // allowance. Only the width is constrained, so the native image ratio also
  // determines its element height (no object-fit letterboxing inside the img).
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    const frame = frameRef.current;
    if (!image || !naturalSize || !overlay || !frame) return undefined;
    const measure = () => {
      const overlayStyle = window.getComputedStyle(overlay);
      const frameStyle = window.getComputedStyle(frame);
      const px = (value: string) => parseFloat(value) || 0;
      const horizontalChrome = px(overlayStyle.paddingLeft) + px(overlayStyle.paddingRight)
        + px(frameStyle.paddingLeft) + px(frameStyle.paddingRight)
        + px(frameStyle.borderLeftWidth) + px(frameStyle.borderRightWidth);
      const verticalChrome = px(overlayStyle.paddingTop) + px(overlayStyle.paddingBottom)
        + px(frameStyle.paddingTop) + px(frameStyle.paddingBottom)
        + px(frameStyle.borderTopWidth) + px(frameStyle.borderBottomWidth);
      const captionHeight = captionRef.current?.getBoundingClientRect().height || 0;
      const availableWidth = Math.max(1, overlay.clientWidth - horizontalChrome);
      const availableHeight = Math.max(1, overlay.clientHeight - verticalChrome
        - captionHeight - (captionHeight ? px(frameStyle.rowGap) : 0));
      const width = Math.floor(Math.min(availableWidth,
        availableHeight * naturalSize.width / naturalSize.height));
      setImageWidth((previous) => previous === width ? previous : width);
    };
    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(overlay);
    if (captionRef.current) observer?.observe(captionRef.current);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [image, naturalSize]);

  if (!image || typeof document === "undefined") return null;

  const imageName = getImageName(image);
  const caption = image.title || image.alt;
  const imageStyle = imageWidth !== null
    ? ({ width: `${imageWidth}px` } satisfies CSSProperties)
    : undefined;

  return createPortal(
    <div ref={overlayRef} className="image-expansion-overlay" role="dialog" aria-modal="true" aria-label={`Expanded ${imageName}`}>
      <button
        type="button"
        className="image-expansion-backdrop"
        aria-label="Close expanded image"
        onClick={onClose}
      />
      <figure ref={frameRef} className="image-expansion-frame">
        <button
          ref={closeButtonRef}
          type="button"
          className="image-expansion-close"
          aria-label="Close expanded image"
          onClick={onClose}
        >
          <span className="image-expansion-close-icon" aria-hidden="true" />
        </button>
        <div className="image-expansion-media">
          <img
            className="image-expansion-image"
            src={image.src}
            alt={image.alt || ""}
            title={image.title}
            style={imageStyle}
            onLoad={(event) => {
              const target = event.currentTarget;
              if (target.naturalWidth > 0 && target.naturalHeight > 0) {
                setNaturalSize({ width: target.naturalWidth, height: target.naturalHeight });
              }
            }}
          />
        </div>
        {caption && <figcaption ref={captionRef} className="image-expansion-caption">{caption}</figcaption>}
      </figure>
    </div>,
    document.body,
  );
}

export function ExpandableImage({ src, alt, title, className, children }: ExpandableImageProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [expandedImage, setExpandedImage] = useState<ExpandedImage | null>(null);

  const closeExpandedImage = useCallback(() => {
    setExpandedImage(null);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);

  const image: ExpandedImage = { src, alt, title };
  const imageName = getImageName(image);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={className ? `expandable-image-button ${className}` : "expandable-image-button"}
        aria-label={`Expand ${imageName}`}
        onClick={() => setExpandedImage(image)}
      >
        {children || (
          <>
            <img src={src} alt={alt || ""} title={title} />
            <span className="image-expand-cue" aria-hidden="true" />
          </>
        )}
      </button>
      <ImageExpansionOverlay image={expandedImage} onClose={closeExpandedImage} />
    </>
  );
}
