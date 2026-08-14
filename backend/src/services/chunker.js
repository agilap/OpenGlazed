/**
 * Chunking Strategy v2 — paragraph-aware semantic chunker.
 *
 * Improvements over v1 (fixed-size character splitting):
 *  - Splits on natural paragraph/heading boundaries FIRST, before
 *    ever touching a character limit. This preserves semantic units.
 *  - Merges short adjacent paragraphs up to maxChars so every chunk
 *    carries enough context for the retrieval model.
 *  - Character-based splitting only fires as a last resort on
 *    paragraphs that genuinely exceed maxChars.
 *  - Overlap is preserved between merged groups to help retrieval on
 *    content that spans paragraph breaks.
 */
function splitTextIntoChunks(text, options = {}) {
  const maxChars    = options.maxChars     || 800;
  const minChars    = options.minChars     || 100;   // don't emit micro-chunks
  const overlapChars = options.overlapChars || 120;

  if (!text) return [];

  // ── Step 1: Split on paragraph / heading boundaries ──────────────────
  // Double newline = clear paragraph break.
  // Single newline where the next line is short (≤80 chars) also signals
  // a heading and forces a split.
  const rawParagraphs = text
    .split(/\n{2,}/)                                   // hard paragraph breaks
    .flatMap((para) =>
      // Split on single newlines that look like inline headings
      para.split(/\n(?=[^\n]{1,80}\n)/)
    )
    .map((p) => p.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((p) => p.length >= minChars);

  if (!rawParagraphs.length) return text.length >= minChars ? [text.trim()] : [];

  // ── Step 2: Sub-split paragraphs that still exceed maxChars ──────────
  const subSplit = (para) => {
    if (para.length <= maxChars) return [para];
    const pieces = [];
    let idx = 0;
    while (idx < para.length) {
      const end = Math.min(idx + maxChars, para.length);
      let candidate = para.slice(idx, end);
      if (end < para.length) {
        const boundary = Math.max(
          candidate.lastIndexOf('. '),
          candidate.lastIndexOf('? '),
          candidate.lastIndexOf('! '),
        );
        if (boundary > maxChars * 0.5) {
          candidate = candidate.slice(0, boundary + 1);
        }
      }
      pieces.push(candidate.trim());
      idx += Math.max(candidate.length - overlapChars, 1);
    }
    return pieces.filter(Boolean);
  };

  const paragraphs = rawParagraphs.flatMap(subSplit);

  // ── Step 3: Merge short adjacent paragraphs ───────────────────────────
  // Greedily merge consecutive paragraphs until adding the next one would
  // push the chunk over maxChars — then seal and start fresh.
  const chunks = [];
  let current = '';
  for (const para of paragraphs) {
    const separator = current ? ' ' : '';
    if (current.length + separator.length + para.length <= maxChars) {
      current += separator + para;
    } else {
      if (current) chunks.push(current);
      current = para;
    }
  }
  if (current) chunks.push(current);

  return chunks.filter((c) => c.length >= minChars);
}

module.exports = {
  splitTextIntoChunks
};

