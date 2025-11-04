const fs = require('fs');
const path = require('path');

const CP1251_TABLE = (() => {
  const base = [
    0x0402, 0x0403, 0x201a, 0x0453, 0x201e, 0x2026, 0x2020, 0x2021, 0x20ac, 0x2030, 0x0409, 0x2039, 0x040a,
    0x040c, 0x040b, 0x040f, 0x0452, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x0098, 0x2122,
    0x0459, 0x203a, 0x045a, 0x045c, 0x045b, 0x045f, 0x00a0, 0x040e, 0x045e, 0x0408, 0x00a4, 0x0490, 0x00a6,
    0x00a7, 0x0401, 0x00a9, 0x0404, 0x00ab, 0x00ac, 0x00ad, 0x00ae, 0x0407, 0x00b0, 0x00b1, 0x0406, 0x0456,
    0x0491, 0x00b5, 0x00b6, 0x00b7, 0x0451, 0x2116, 0x0454, 0x00bb, 0x0458, 0x0405, 0x0455, 0x0457
  ];

  const map = new Map();
  for (let i = 0; i < base.length; i += 1) {
    map.set(base[i], 0x80 + i);
  }

  for (let i = 0; i <= 0x1f; i += 1) {
    map.set(i, i);
  }

  for (let i = 0x20; i <= 0x7e; i += 1) {
    map.set(i, i);
  }

  map.set(0x7f, 0x7f);

  // Cyrillic capital letters А (0x0410) - Я (0x042f)
  for (let i = 0; i < 32; i += 1) {
    map.set(0x0410 + i, 0xc0 + i);
  }

  // Cyrillic small letters а (0x0430) - п (0x043f)
  for (let i = 0; i < 16; i += 1) {
    map.set(0x0430 + i, 0xe0 + i);
  }

  // Remaining small letters р (0x0440) - я (0x044f)
  for (let i = 0; i < 16; i += 1) {
    map.set(0x0440 + i, 0xf0 + i);
  }

  return map;
})();

const toCp1251Byte = (codePoint) => {
  if (CP1251_TABLE.has(codePoint)) {
    return CP1251_TABLE.get(codePoint);
  }
  return null;
};

const suspiciousCharRegex = /([РСВ][\u0080-\u00ff])|[\u0400-\u040f\u0450-\u045f\u2010-\u203a\u2116\u2122]/;

const decodeCandidate = (raw) => {
  if (!suspiciousCharRegex.test(raw)) {
    return null;
  }

  const bytes = [];

  for (const char of raw) {
    const code = char.codePointAt(0);
    if (code > 0xffff) {
      return null;
    }
    const byte = toCp1251Byte(code);
    if (byte === null) {
      return null;
    }
    bytes.push(byte);
  }

  if (bytes.length === 0) {
    return null;
  }

  const decoded = Buffer.from(bytes).toString('utf8');
  if (!decoded || decoded === raw || decoded.includes('\uFFFD')) {
    return null;
  }

  const hasNonAscii = /[^\u0000-\u007f]/.test(decoded);
  if (!hasNonAscii) {
    return null;
  }

  return decoded;
};

const escapeString = (value, quote) => {
  const pattern = new RegExp(quote.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g');
  return value.replace(/\\/g, '\\\\').replace(pattern, `\\${quote}`);
};

const processFile = (filePath) => {
  const absPath = path.resolve(filePath);
  const content = fs.readFileSync(absPath, 'utf8');
  let output = '';
  let changed = 0;

  const isEscaped = (text, index) => {
    let backslashes = 0;
    let cursor = index - 1;
    while (cursor >= 0 && text[cursor] === '\\') {
      backslashes += 1;
      cursor -= 1;
    }
    return backslashes % 2 === 1;
  };

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    if ((char === '"' || char === "'" || char === '`') && !isEscaped(content, i)) {
      const quote = char;
      if (quote === '`') {
        let cursor = i + 1;
        let literalBuffer = '';
        let templateTerminated = false;

        const flushLiteral = () => {
          if (!literalBuffer) {
            return false;
          }
          const decoded = decodeCandidate(literalBuffer);
          if (decoded) {
            changed += 1;
            output += escapeString(decoded, quote);
            literalBuffer = '';
            return true;
          }
          output += literalBuffer;
          literalBuffer = '';
          return false;
        };

        output += quote;
        while (cursor < content.length) {
          const current = content[cursor];
          if (current === '\\') {
            if (cursor + 1 < content.length) {
              literalBuffer += current + content[cursor + 1];
              cursor += 2;
              continue;
            }
          }
          if (current === '`' && !isEscaped(content, cursor)) {
            flushLiteral();
            output += '`';
            templateTerminated = true;
            break;
          }
          if (current === '$' && content[cursor + 1] === '{') {
            flushLiteral();
            output += '${';
            cursor += 2;
            let depth = 1;
            while (cursor < content.length && depth > 0) {
              const exprChar = content[cursor];
              output += exprChar;
              if (exprChar === '{') {
                depth += 1;
              } else if (exprChar === '}') {
                depth -= 1;
              } else if (exprChar === '\\') {
                const next = content[cursor + 1];
                if (next !== undefined) {
                  cursor += 1;
                  output += next;
                }
              }
              cursor += 1;
            }
            continue;
          }
          literalBuffer += current;
          cursor += 1;
        }

        if (!templateTerminated) {
          output += literalBuffer;
          continue;
        }

        i = cursor;
      } else {
        let cursor = i + 1;
        let inner = '';
        let terminated = false;

        while (cursor < content.length) {
          const current = content[cursor];
          if (current === '\\') {
            if (cursor + 1 < content.length) {
              inner += current + content[cursor + 1];
              cursor += 2;
              continue;
            }
          }
          if (current === quote && !isEscaped(content, cursor)) {
            terminated = true;
            break;
          }
          inner += current;
          cursor += 1;
        }

        if (!terminated) {
          output += char;
          continue;
        }

        const decoded = decodeCandidate(inner);
        if (decoded) {
          changed += 1;
          output += quote + escapeString(decoded, quote) + quote;
        } else {
          output += quote + inner + quote;
        }

        i = cursor;
      }
    } else {
      output += char;
    }
  }

  const sequencePattern = /([\u0400-\u045f\u00a0-\u00ff\u2010-\u203a\u2116\u2122]{2,})/g;
  let sequenceChanged = false;
  output = output.replace(sequencePattern, (segment) => {
    const decoded = decodeCandidate(segment);
    if (decoded && decoded !== segment) {
      sequenceChanged = true;
      return decoded;
    }
    return segment;
  });

  if (!changed && !sequenceChanged) {
    return false;
  }

  fs.writeFileSync(absPath, output, 'utf8');
  return true;
};

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/fixBrokenText.js <file>');
  process.exit(1);
}

const didChange = processFile(target);
if (!didChange) {
  console.log('No broken strings detected.');
} else {
  console.log('Broken strings fixed.');
}
