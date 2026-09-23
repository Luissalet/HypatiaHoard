import React from "react";

// A tiny, safe markdown renderer: **bold**, *italics*, `code`, and line
// breaks. No raw HTML is ever interpreted — everything is plain text nodes
// wrapped in React elements, so there is no dangerouslySetInnerHTML anywhere.
const INLINE = /\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`/g;

function renderLine(line, keyPrefix) {
  const nodes = [];
  let last = 0;
  let index = 0;
  let match;
  INLINE.lastIndex = 0;
  while ((match = INLINE.exec(line))) {
    if (match.index > last) nodes.push(line.slice(last, match.index));
    if (match[1] !== undefined) nodes.push(<strong key={`${keyPrefix}-${index++}`}>{match[1]}</strong>);
    else if (match[2] !== undefined) nodes.push(<em key={`${keyPrefix}-${index++}`}>{match[2]}</em>);
    else if (match[3] !== undefined) nodes.push(<code key={`${keyPrefix}-${index++}`}>{match[3]}</code>);
    last = INLINE.lastIndex;
  }
  if (last < line.length) nodes.push(line.slice(last));
  return nodes.length ? nodes : [""];
}

export function Markdown({ text, className }) {
  const lines = String(text ?? "").split(/\r?\n/);
  return (
    <span className={className}>
      {lines.map((line, i) => (
        <React.Fragment key={i}>
          {i > 0 && <br />}
          {renderLine(line, i)}
        </React.Fragment>
      ))}
    </span>
  );
}
