// The spellings of a line that a reader would not see but a program would: percent-encoding, the backslash escapes of a script or JSON string, and HTML
// entities. A term that is spelled in one of them is as much a leak as one that is spelled out, and the scanner looks at the decoded line as well as at the
// line itself.
//
//   percent        %2F %7a %C3%A9                    every %XX, the bytes read as UTF-8 (bytes that are not UTF-8 stay, the ASCII ones around them do not)
//   escapes        \u0041 \u{1F600} \x41             a surrogate pair written as two \u escapes is one character
//   entities       &#65; &#x41; &amp; &sol; &commat;  numeric ones, and the named ones in NAMED
//
// One pass decodes the escapes, then the entities, then the percent-encoding, so that one layer inside another is decoded at once. A second pass decodes what
// the first made (a double encoding); a third is never made. Nothing here reads a file or knows a denylist, and nothing returns more than the decoded lines.

const MAX_PASSES = 2;

// The named entities that code writes in place of a punctuation mark of a path, an address or an identifier.
const NAMED = new Map(Object.entries({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", sol: "/", bsol: "\\", colon: ":", period: ".", commat: "@", lowbar: "_" }));

const ESCAPE = /\\(?:u\{([0-9A-Fa-f]{1,6})\}|u([0-9A-Fa-f]{4})|x([0-9A-Fa-f]{2}))/g;
const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9A-Fa-f]{1,6})|([A-Za-z]{2,8}));/g;
const PERCENT_RUN = /(?:%[0-9A-Fa-f]{2})+/g;
const MARKS = /[%\\&]/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** The character of a code point that is a character (not 0, not beyond Unicode, not half of a surrogate pair), or null. */
function character(codePoint) {
  return codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff) ? String.fromCodePoint(codePoint) : null;
}

function decodeEscapes(text) {
  return text.replace(ESCAPE, (whole, braced, four, two) => {
    if (four !== undefined) return String.fromCharCode(Number.parseInt(four, 16));
    if (two !== undefined) return String.fromCharCode(Number.parseInt(two, 16));
    return character(Number.parseInt(braced, 16)) ?? whole;
  });
}

function decodeEntities(text) {
  return text.replace(ENTITY, (whole, decimal, hexadecimal, name) => {
    if (decimal !== undefined) return character(Number.parseInt(decimal, 10)) ?? whole;
    if (hexadecimal !== undefined) return character(Number.parseInt(hexadecimal, 16)) ?? whole;
    return NAMED.get(name) ?? whole;
  });
}

function decodePercent(text) {
  return text.replace(PERCENT_RUN, (run) => {
    const bytes = Buffer.from(run.replaceAll("%", ""), "hex");
    try {
      return UTF8.decode(bytes);
    } catch {
      let decoded = "";
      for (let at = 0; at < run.length; at += 3) {
        const byte = Number.parseInt(run.slice(at + 1, at + 3), 16);
        decoded += byte < 0x80 ? String.fromCharCode(byte) : run.slice(at, at + 3);
      }
      return decoded;
    }
  });
}

/** The decoded lines of `text`, one for each pass that changed it (at most two): [] for a line that has nothing to decode. */
export function decodedVariants(text) {
  if (!MARKS.test(text)) return [];
  const variants = [];
  let current = text;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const next = decodePercent(decodeEntities(decodeEscapes(current)));
    if (next === current) break;
    variants.push(next);
    current = next;
  }
  return variants;
}
