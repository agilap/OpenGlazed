/* ─────────────────────────────────────────────────────────────────
   Refiner — turn raw scraped sections (heading + wall-of-text)
   into clean, topic-labelled paragraphs ready for storage.

   Flow:  raw sections  →  clean paragraphs  →  topic assignment
          →  split if too long  →  ready for DB
───────────────────────────────────────────────────────────────── */

/* ── Topic taxonomy ─────────────────────────────────────────── */
const TOPIC_KEYWORDS = {
  about:      ['about','who we are','our story','story','mission','vision','overview',
               'founded','founding','creating','company','who is'],
  brands:     ['brand','brands','hero brand','our brands','cuisine','restaurant',
               'burger','pizza','chicken','sushi','ramen','poke','korean',
               'vietnamese','filipino','western','healthy appetite','burger beast',
               "pia's kitchen",'umami'],
  menu:       ['menu','dish','dishes','recipe','recipes','food','flavor','flavour',
               'ingredient','chef','cook','patty','sauce','bun','fillet',
               'onion ring','ketchup','coleslaw','buffalo','best seller'],
  delivery:   ['deliver','delivery','delivers','order','ordering','grab','grabfood',
               'foodpanda','aggregator','coverage','metro manila','available',
               'accessible','wallet-friendly','convenient','310 peso'],
  technology: ['technology','tech','api','integration','cloud kitchen','platform',
               'proprietary','data','operations','multi-brand','multi-cuisine',
               'multi-platform','commissary','process','packaging','menu engineering',
               'digitization'],
  careers:    ['career','careers','job','jobs','join','hiring','team','openings',
               'growing','talent','engineer','work','apply','role','position'],
  funding:    ['funding','raised','raises','series','investor','venture','capital',
               'million','$5m','$7m','nordstar','seed','pre-seed'],
  services:   ['service','services','cloud kitchen operator','restaurant group',
               'ghost kitchen','virtual kitchen','partner'],
  locations:  ['location','locations','manila','philippines','vietnam','ho chi minh',
               'southeast asia','sea','expansion','expand','market'],
  press:      ['press','news','techcrunch','techinasia','e27','media','coverage',
               'article','announcement'],
  contact:    ['contact','inquiry','form','message','email','reach','note'],
};

/**
 * Assign the best-matching topic to a section based on its heading
 * and content.  Heading keywords carry 3× weight.
 */
function assignTopic(heading, content) {
  const h = (heading || '').toLowerCase();
  const c = (content || '').toLowerCase();
  let best = 'about';  // default fallback
  let bestScore = 0;

  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (h.includes(kw)) score += 3;
      if (c.includes(kw)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = topic;
    }
  }

  return best;
}

/* ── Smart quote normalisation ──────────────────────────────── */
function normaliseQuotes(text) {
  return text
    .replace(/[\u2018\u2019\u201A\u2039\u203A]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"');
}

/* ── Smart ALL-CAPS block splitter ──────────────────────────── */
const CONSONANT_STARTS = new Set([
  'bl','br','ch','cl','cr','dr','dw','fl','fr','gl','gr',
  'kn','ph','pl','pr','qu','rh','sc','sh','sk','sl','sm',
  'sn','sp','sq','st','sw','th','tr','tw','wh','wr'
]);

/**
 * Heuristic: does (uppercase + lowercase) form a plausible
 * English word start?  Used to decide where to split ALL-CAPS
 * blocks that are mashed against the next word.
 */
function isValidWordStart(ch1, ch2) {
  const pair = (ch1 + ch2).toLowerCase();
  if (/[aeiou]/.test(pair)) return true;
  return CONSONANT_STARTS.has(pair);
}

/**
 * Split ALL-CAPS blocks (3+ letters) from the following text.
 * Handles both uppercase→title-case and uppercase→lowercase:
 *   "BEASTUnleashing"  → "BEAST. Unleashing"
 *   "PROVIDINGflavorful" → "PROVIDING. flavorful"
 */
function splitCaps(text) {
  return text.replace(/[A-Z]{3,}/g, (block, offset, full) => {
    const afterIdx = offset + block.length;
    const charAfter = full[afterIdx] || '';
    if (!charAfter || /[^a-zA-Z]/.test(charAfter)) return block;
    if (/[A-Z]/.test(charAfter)) return block;
    // Followed by lowercase
    const lastUpper = block[block.length - 1];
    if (isValidWordStart(lastUpper, charAfter)) {
      return block.slice(0, -1) + '. ' + lastUpper;
    } else {
      return block + '. ';
    }
  });
}

/* ── Patterns that should be stripped from content ───────────── */
const JUNK_RE = [
  /---+/g,
  /[^\n.!?]*\|\s*CloudEats[^\n]*/gi,
  /CONNECT WITH [A-Z\s']+/gi,
  /\bMore Success Stories\b/gi,
  /\bRead more\.?\b/gi,
  /\bRead about it\.?\b/gi,
  /\bSee Careers\b/gi,
  /\bDiscover Our (?:Hero )?Brands?\b/gi,
  /\bApply to CloudEats\b/gi,
  /Stay tuned[^.!]*[.!]?/gi,
  /Want to hear more[^.!?]*[.!?]?/gi,
  /Type of Inquiry.*?(?:Thanks for submitting!?|$)/gi,
  /\bSend message\b/gi,
  /Let us know using the form below\.?/gi,
  /We share stories of our brands[^.!]*[.!]?/gi,
  /\b(?:TECHCRUNCH|TECHINASIA|E27)\b[^.]*?\d{4}/gi,
  /\d{4}\s+CAREERS?\b/gi,
  /\bLATEST OPENINGS?\b[^.!?]*/gi,
  /Find the one for you!?/gi,
  /\bSUCCESS STORIES\b/gi,
  /\bCAREERSA?\s+growing\b/gi,
  /Go Local\??/gi,
  /\.{3}and many more!?/gi,
  /For press and other inquiries[^.]*\./gi,
  /drop us a note at \S+/gi,
  /Alibaba-backed VC firm[^.]*\??/gi,
  /Featuring our Celebrity Brands?/gi,
  /Raves & Reviews?/gi,
];

/* Navigation phrases that mark a sentence as junk */
const NAV_PHRASES = [
  'discover our brands','discover our hero brands','read about it','apply now',
  'see careers','more success stories','get in touch','latest openings',
  'find the one for you','stay tuned','thanks for submitting','type of inquiry',
  'send message','success stories','raves & reviews','featuring our celebrity',
  'and many more','drop us a note','learn more about our brand',
];

/**
 * Clean a raw section's content into proper, readable prose.
 * Returns a trimmed string (may be empty if the section was all junk).
 */
function cleanContent(raw) {
  let t = normaliseQuotes(raw);

  // Strip known web junk
  for (const re of JUNK_RE) t = t.replace(re, ' ');

  // Split ALL-CAPS blocks mashed into next word (smart heuristic)
  t = splitCaps(t);

  // Split lowercase/digit into ALL-CAPS: "brandsBURGER" → "brands. BURGER"
  t = t.replace(/([a-z0-9])([A-Z]{2,})/g, '$1. $2');

  // Split CamelCase mashings: "EngineeringOur" → "Engineering. Our"
  t = t.replace(/([a-z])([A-Z][a-z]{2,})/g, '$1. $2');

  // Restore brand names
  t = t.replace(/Cloud\.\s*Eats/g, 'CloudEats');
  t = t.replace(/Grab\.\s*Food/g, 'GrabFood');
  t = t.replace(/Food\.\s*Panda/g, 'FoodPanda');

  // Split stuck punctuation+caps: "food.Read" → "food. Read"
  t = t.replace(/([.!?])([A-Z])/g, '$1 $2');

  // Collapse whitespace
  t = t.replace(/\s+/g, ' ').trim();

  // Now extract clean sentences
  const sentences = t.split(/(?<=[.!?])\s+/).filter((s) => {
    const trimmed = s.trim();
    if (trimmed.length < 30) return false;
    if (trimmed.length > 600) return false;
    // ALL-CAPS fragment
    if (/^[A-Z\s&|•\-:!'?,.$]+$/.test(trimmed)) return false;
    // Mostly uppercase + short = header
    const lc = (trimmed.match(/[a-z]/g) || []).length;
    const uc = (trimmed.match(/[A-Z]/g) || []).length;
    if (uc > lc * 1.5 && trimmed.length < 80) return false;
    // Navigation phrase
    const lower = trimmed.toLowerCase();
    if (NAV_PHRASES.some((p) => lower.includes(p))) return false;
    return true;
  }).map((s) => {
    let trimmed = s.trim();
    // Strip leading ALL-CAPS labels: "BRANDS. Our..." → "Our..."
    // Requires 3+ consecutive uppercase to avoid stripping "A Manila..."
    // Allows possessives like "PIA'S"; requires 2+ uppercase after spaces
    trimmed = trimmed.replace(/^(?:[A-Z]{3,}(?:[\s&]+[A-Z]{2,}|'[A-Z])*[.!?:,]?\s*)+/, '');
    // Re-capitalise
    if (trimmed && /^[a-z]/.test(trimmed)) {
      trimmed = trimmed[0].toUpperCase() + trimmed.slice(1);
    }
    // Ensure trailing punctuation
    if (trimmed && !/[.!?]$/.test(trimmed)) trimmed += '.';
    return trimmed;
  }).filter((s) => s.length >= 30);

  return sentences.join(' ');
}

/**
 * Split a long paragraph at sentence boundaries, keeping each chunk
 * under maxChars.  Every resulting chunk inherits the same topic.
 */
function splitParagraph(text, maxChars = 800) {
  if (text.length <= maxChars) return [text];

  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let current = '';

  for (const sent of sentences) {
    if (current.length + sent.length + 1 > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = '';
    }
    current += (current ? ' ' : '') + sent;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/**
 * Main entry point.  Takes an array of raw scraped sections and
 * returns an array of clean, topic-labelled chunks ready for DB.
 *
 * Input:  [{ heading: string, content: string, url: string }]
 * Output: [{ topic: string, heading: string, text: string, url: string }]
 */
function refineSections(rawSections) {
  const results = [];

  for (const section of rawSections) {
    const cleaned = cleanContent(section.content);
    if (!cleaned || cleaned.length < 40) continue;  // skip empty / tiny

    const topic = assignTopic(section.heading, cleaned);

    // Skip pure contact-form / junk sections
    if (topic === 'contact' && cleaned.length < 100) continue;

    const heading = (section.heading || '').replace(/\s+/g, ' ').trim();

    // Split if too long
    const paragraphs = splitParagraph(cleaned, 800);
    for (const para of paragraphs) {
      results.push({
        topic,
        heading,
        text: para,
        url: section.url || '',
      });
    }
  }

  return results;
}

module.exports = {
  refineSections,
  assignTopic,
  cleanContent,
  splitCaps,
};
