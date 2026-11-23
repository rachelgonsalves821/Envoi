import { CATEGORY_LABEL, TIER_LABEL, findHighlights, splitByHighlights } from './highlights';

export function HighlightedText({ text }: { text: string }) {
  const pieces = splitByHighlights(text, findHighlights(text));
  return <>{pieces.map((piece, index) => {
    const mark = piece.highlight;
    if (!mark) return <span key={index}>{piece.text}</span>;
    const label = `${TIER_LABEL[mark.tier]}: ${CATEGORY_LABEL[mark.category]}. ${mark.reason}`;
    return <mark key={index} className={`hl hl-${mark.tier}`} tabIndex={0} title={label}>{piece.text}<span className="sr-only"> ({label})</span></mark>;
  })}</>;
}

export function HighlightLegend() {
  return <p className="hl-legend" aria-label="Highlight key"><mark className="hl">Underlined terms</mark><span>Hover or focus a term to see why it’s flagged.</span></p>;
}
