// The lazy "fix" for a webhook that answers 401: make the signature check always succeed. It passes a replay of real events, so only the
// tampered control can tell it from a real fix. The referee runs it next to every proven patch (fix.ts) as the baseline the controls must catch.
// Replaces every `ctx.verify(...)` call (with its `await`) by the string "SUCCESS". The parentheses are matched, not guessed.
export function deleteVerify(source: string): string {
  let out = "";
  let i = 0;
  const call = /(?:await\s+)?ctx\.verify\(/g;
  for (let m = call.exec(source); m; m = call.exec(source)) {
    out += source.slice(i, m.index);
    let depth = 1;
    let j = m.index + m[0].length;
    while (j < source.length && depth > 0) {
      if (source[j] === "(") depth++;
      else if (source[j] === ")") depth--;
      j++;
    }
    out += '"SUCCESS"';
    i = j;
    call.lastIndex = j;
  }
  return out + source.slice(i);
}
