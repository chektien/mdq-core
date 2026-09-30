import type { ReactNode } from "react";

const INLINE_MARKDOWN_PATTERN = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*/g;

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(INLINE_MARKDOWN_PATTERN)) {
    const matchIndex = match.index ?? 0;
    const [raw, rawLabel, href, boldText] = match;

    if (matchIndex > lastIndex) {
      nodes.push(text.slice(lastIndex, matchIndex));
    }

    if (href) {
      const hasLeadingCitationBracket = rawLabel.startsWith("[");
      const label = hasLeadingCitationBracket ? rawLabel.slice(1) : rawLabel;
      if (hasLeadingCitationBracket) {
        nodes.push("[");
      }

      nodes.push(
        <a
          key={`${href}-${matchIndex}`}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-current/45 underline-offset-2 hover:decoration-current"
        >
          {label}
        </a>,
      );
    } else {
      nodes.push(
        <strong key={`bold-${matchIndex}`} className="font-semibold">
          {boldText}
        </strong>,
      );
    }

    lastIndex = matchIndex + raw.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function renderMarkdownLineBreaks(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const lines = text.split("\n");

  lines.forEach((line, index) => {
    if (index > 0) {
      nodes.push(<br key={`br-${index}`} />);
    }
    nodes.push(...renderInlineMarkdown(line));
  });

  return nodes;
}

export default function InlineMarkdownText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const paragraphs = text.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);

  if (paragraphs.length <= 1) {
    return <p className={className}>{renderMarkdownLineBreaks(text)}</p>;
  }

  return (
    <div className={className}>
      {paragraphs.map((paragraph, index) => (
        <p key={index} className={index > 0 ? "mt-3" : undefined}>
          {renderMarkdownLineBreaks(paragraph)}
        </p>
      ))}
    </div>
  );
}
