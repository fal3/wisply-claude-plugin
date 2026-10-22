// A reader for the small, block-style subset of YAML the release workflow is
// written in, so tests/manifests.test.mjs can check its structure without a
// YAML dependency. Anything outside the subset throws, so the workflow can't
// pass the checks by using syntax the reader would misread:
//
//   key: value | key: (then a deeper block) | key: {} | key: []
//   - value | - key: value (a mapping item; its other keys line up after "- ")
//   plain, 'single-quoted' and "double-quoted" (no escapes) scalars
//   full-line and trailing " #" comments
//
// Refused: tabs, flow collections other than {} and [], anchors, aliases,
// tags, block scalars (| and >), document markers, duplicate keys, keys other
// than [A-Za-z0-9_-]+, and plain scalars that start with an indicator.

/** Removes a comment that starts outside quotes: at the line start, or after whitespace. */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote) {
      if (char === quote) quote = null;
    } else if ((char === "'" || char === '"') && (i === 0 || /[\s:[{,-]/.test(line[i - 1]))) {
      quote = char;
    } else if (char === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).replace(/\s+$/, '');
    }
  }
  if (quote) throw new Error(`unterminated quote: ${line}`);
  return line.replace(/\s+$/, '');
}

/** A scalar value: quoted strings, {} and [], integers, booleans, else a plain string. */
function scalar(text, where) {
  if (text === '{}') return {};
  if (text === '[]') return [];
  const single = /^'((?:[^']|'')*)'$/.exec(text);
  if (single) return single[1].replaceAll("''", "'");
  const double = /^"([^"\\]*)"$/.exec(text);
  if (double) return double[1];
  if (/^['"]/.test(text)) throw new Error(`${where}: unsupported quoted scalar ${text}`);
  if (/^[[{&*!|>%@`,?:-]/.test(text) && !/^-?\d+$/.test(text)) {
    throw new Error(`${where}: unsupported value ${text}`);
  }
  if (/:(\s|$)/.test(text)) throw new Error(`${where}: ": " inside a plain scalar: ${text}`);
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^(null|~|yes|no|on|off|y|n)$/i.test(text)) throw new Error(`${where}: ambiguous scalar ${text}; quote it`);
  return text;
}

/**
 * @param {string} text
 * @returns {any}
 */
export function parseWorkflow(text) {
  if (text.includes('\t')) throw new Error('tabs are not supported');
  const lines = [];
  text.split('\n').forEach((raw, index) => {
    const line = stripComment(raw);
    if (line.trim() === '') return;
    if (/^(---|\.\.\.)(\s|$)/.test(line)) throw new Error(`line ${index + 1}: document markers are not supported`);
    const indent = line.length - line.trimStart().length;
    lines.push({ indent, body: line.trimStart(), number: index + 1 });
  });
  let at = 0;

  /** Parses `key: value` (or `key:` and a deeper block) into `target`. */
  function entry(target, body, indent, number) {
    const match = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(body);
    if (!match) throw new Error(`line ${number}: expected "key: value", found ${body}`);
    const [, key, value] = match;
    if (Object.hasOwn(target, key)) throw new Error(`line ${number}: duplicate key ${key}`);
    if (value === undefined || value === '') {
      const next = lines[at];
      if (!next || next.indent <= indent) throw new Error(`line ${number}: ${key} has no value`);
      target[key] = block(next.indent);
    } else {
      target[key] = scalar(value, `line ${number}`);
    }
  }

  /** A mapping or a sequence whose lines all start at `indent`. */
  function block(indent) {
    const first = lines[at];
    if (first.body.startsWith('- ') || first.body === '-') {
      const items = [];
      while (at < lines.length && lines[at].indent === indent && lines[at].body.startsWith('- ')) {
        const { body, number } = lines[at];
        at += 1;
        const rest = body.slice(2).trimStart();
        if (/^[A-Za-z0-9_-]+:(\s|$)/.test(rest)) {
          // A mapping item: its first key is on the dash line, the others line up with it.
          const item = {};
          const keyIndent = indent + (body.length - rest.length);
          entry(item, rest, keyIndent, number);
          while (at < lines.length && lines[at].indent === keyIndent) {
            const line = lines[at];
            at += 1;
            entry(item, line.body, keyIndent, line.number);
          }
          items.push(item);
        } else {
          items.push(scalar(rest, `line ${number}`));
        }
      }
      if (at < lines.length && lines[at].indent > indent) throw new Error(`line ${lines[at].number}: unexpected indentation`);
      return items;
    }
    const mapping = {};
    while (at < lines.length && lines[at].indent === indent) {
      const line = lines[at];
      if (line.body.startsWith('- ')) throw new Error(`line ${line.number}: a sequence item inside a mapping`);
      at += 1;
      entry(mapping, line.body, indent, line.number);
    }
    if (at < lines.length && lines[at].indent > indent) throw new Error(`line ${lines[at].number}: unexpected indentation`);
    return mapping;
  }

  if (lines.length === 0) throw new Error('empty document');
  if (lines[0].indent !== 0) throw new Error('the document must start at column 0');
  const document = block(0);
  if (at !== lines.length) throw new Error(`line ${lines[at].number}: unexpected content`);
  return document;
}

/**
 * Every `uses:` in a workflow's text, as {action, ref, comment}. The comment
 * is the version tag Dependabot keeps next to a SHA pin.
 * @param {string} text
 */
export function actionPins(text) {
  return [...text.matchAll(/^\s*(?:-\s+)?uses:\s*([^\s@#]+)@(\S+)(?:\s+#\s*(\S+))?\s*$/gm)]
    .map((match) => ({ action: match[1], ref: match[2], comment: match[3] ?? null }));
}
