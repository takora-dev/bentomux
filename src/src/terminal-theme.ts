/* Builds the xterm.js theme from the stylesheet's palette tokens.
   Kept free of Tauri/app imports so it can be exercised standalone. */

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/* xterm's color parser only knows hex and rgb()/rgba(), while palette
   tokens may arrive as color-mix() strings (the custom palette derives its
   ANSI colors that way). A scratch element resolves any CSS color to its
   computed rgb() form; anything unresolvable keeps the fallback. */
let colorProbe: HTMLElement | null = null;

function toXtermColor(value: string, fallback: string): string {
  if (!value) return fallback;
  if (/^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%/]+\))$/i.test(value)) return value;
  if (!colorProbe) {
    colorProbe = document.createElement('span');
    colorProbe.style.display = 'none';
    document.documentElement.append(colorProbe);
  }
  try {
    colorProbe.style.color = value;
    const resolved = getComputedStyle(colorProbe).color;
    if (resolved && /^(#[0-9a-f]|rgba?\()/i.test(resolved)) return resolved;
  } catch {
    /* keep the fallback */
  }
  return fallback;
}

/* the --tint wash (7%) is too faint to see over busy terminal output, so
   hold the selection at a visible level while keeping the palette's hue */
function selectionColor(fallback: string): string {
  const raw = toXtermColor(cssVar('--tint'), fallback);
  const m = raw.match(/^rgba?\(([^)]+)\)$/i);
  if (!m) return raw;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return raw;
  const rgb = parts.slice(0, 3).map(p => Math.round(parseFloat(p)) || 0);
  const alpha = parts.length > 3 ? parseFloat(parts[3]) : 1;
  return 'rgba(' + rgb.join(',') + ',' + Math.max(alpha, 0.25) + ')';
}

const ANSI_VARS: Array<[string, string]> = [
  ['black', '--ansi-black'], ['red', '--ansi-red'], ['green', '--ansi-green'], ['yellow', '--ansi-yellow'],
  ['blue', '--ansi-blue'], ['magenta', '--ansi-magenta'], ['cyan', '--ansi-cyan'], ['white', '--ansi-white'],
  ['brightBlack', '--ansi-bright-black'], ['brightRed', '--ansi-bright-red'],
  ['brightGreen', '--ansi-bright-green'], ['brightYellow', '--ansi-bright-yellow'],
  ['brightBlue', '--ansi-bright-blue'], ['brightMagenta', '--ansi-bright-magenta'],
  ['brightCyan', '--ansi-bright-cyan'], ['brightWhite', '--ansi-bright-white'],
];

/* xterm's built-in 16 colors assume a dark canvas; these neutral sets back
   the stylesheet's --ansi-* vars until they resolve (VS Code light/dark) */
const FALLBACK_ANSI: Record<'light' | 'dark', Record<string, string>> = {
  light: {
    black: '#000000', red: '#cd3131', green: '#00bc00', yellow: '#949800',
    blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc', white: '#555555',
    brightBlack: '#666666', brightRed: '#cd3131', brightGreen: '#14ce14', brightYellow: '#b5ba00',
    brightBlue: '#0451a5', brightMagenta: '#bc05bc', brightCyan: '#0598bc', brightWhite: '#a5a5a5',
  },
  dark: {
    black: '#666666', red: '#f14c4c', green: '#23d18b', yellow: '#f5f543',
    blue: '#3b8eea', magenta: '#d670d6', cyan: '#29b8db', white: '#e5e5e5',
    brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543',
    brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5',
  },
}

export function xtermTheme(): Record<string, string> {
  const fb = FALLBACK_ANSI[document.documentElement.classList.contains('dark') ? 'dark' : 'light'];
  const ink = toXtermColor(cssVar('--ink'), '#292827');
  /* with a workspace or terminal wallpaper active (html.bg-content /
     html.bg-terminal, set by applyBackgrounds) an image is painted behind
     the panes — the terminal canvas goes transparent and readability is the
     user's opacity/dim setting. cursorAccent stays opaque: it fills the
     block cursor, where a transparent color would hide the character under
     it. */
  const root = document.documentElement.classList;
  const transparentBg = root.contains('bg-content') || root.contains('bg-terminal');
  const bg = transparentBg ? 'rgba(0,0,0,0)' : toXtermColor(cssVar('--content-bg'), '#FAFAFA');
  const theme: Record<string, string> = {
    background: bg,
    foreground: ink,
    cursor: toXtermColor(cssVar('--ink-2'), '#686766'),
    cursorAccent: toXtermColor(cssVar('--content-bg'), '#FAFAFA'),
    selectionBackground: selectionColor('rgba(35,42,52,.25)'),
    selectionForeground: ink,
  };
  for (const [key, cssName] of ANSI_VARS) {
    theme[key] = toXtermColor(cssVar(cssName), fb[key]);
  }
  return theme;
}
