/* ---------------- custom palette color parsing ----------------
   Kept separate from types.ts so it stays importable by a plain node test
   (types.ts pulls in the plugin SDK). */

const COLOR_RE = /^(?:#([0-9a-f]{3}|[0-9a-f]{6})|rgb\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*\))$/i;

export function isColor(v: string): boolean {
  return COLOR_RE.test(v.trim());
}

/* hex form for <input type="color">, which only speaks #rrggbb; '' when the
   value is not a color we understand */
export function toHex(v: string): string {
  const m = COLOR_RE.exec(v.trim());
  if (!m) return '';
  if (m[1]) return (m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1]).toLowerCase();
  return [m[2], m[3], m[4]].map(n => Math.min(255, +n).toString(16).padStart(2, '0')).join('');
}
