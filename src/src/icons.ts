/* ---------------- icons & glyphs ----------------
   One icon family for the whole app: Lucide (`lucide`), which ships each
   icon as an array of `[tag, attrs]` pairs. We render those ourselves into
   a plain <svg> string instead of using lucide's createElement wrapper so
   the existing `markup()` contract holds — the SVG is a compile-time
   constant built from a trusted package, never file or user content.

   `IC` is the 14px default set, kept as a map of SVG strings because
   `plugin/icons.ts` resolves a plugin's `{ type: 'builtin', name }` against
   it by key. `icon(name, size)` renders the same glyph at another size for
   the handful of places (window controls, tab tiles, chips) that need one. */

import { h, markup } from './dom';
import {
  Bell, Bot, ChevronLeft, ChevronRight, Clock, Columns2, Copy, Diamond,
  Download, Ellipsis, Folder, FolderPlus, GitBranch, Image, Info, KeyRound,
  LayoutGrid, List, MessageSquare, Minus, Moon, PanelLeft, Plus, RefreshCw,
  Search, Settings, SlidersHorizontal, Smartphone, Square, SquareStack, Sun,
  Terminal, Trash2, X,
  type IconNode,
} from 'lucide';

/* Lucide's own defaults: a 24-unit box drawn in currentColor with a 2-unit
   round stroke. `size` only sets the box, so a caller that renders a 14px
   icon gets the same optical weight as a 20px one. */
function svg(node: IconNode, size: number): string {
  const body = node
    .map(([tag, attrs]) => '<' + tag + ' ' + attrsToMarkup(attrs) + '/>')
    .join('');
  return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24"'
    + ' fill="none" stroke="currentColor" stroke-width="2"'
    + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + body + '</svg>';
}

/* Lucide attribute values are authored inside the package, but escape them
   anyway: `markup()` writes with innerHTML, so this is the one place a stray
   quote would break out of the tag. */
function attrsToMarkup(attrs: Record<string, string | number | undefined>): string {
  return Object.entries(attrs)
    .filter(([, v]) => v != null)
    .map(([k, v]) => k + '="' + String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"')
    .join(' ');
}

/* Every glyph the app draws. Sizes are chosen per role below; the map is the
   contract a plugin's `builtin` icon name resolves against, so a key added
   here becomes a name plugins may use. */
const NODES = {
  /* navigation & chrome */
  lines: List,
  board: LayoutGrid,
  chev: ChevronRight,
  back: ChevronLeft,
  dots: Ellipsis,
  /* git & workspaces */
  git: GitBranch,
  folder: Folder,
  folderPlus: FolderPlus,
  clock: Clock,
  /* agents & runtime */
  bot: Bot,
  chat: MessageSquare,
  term: Terminal,
  /* settings & actions */
  search: Search,
  gear: Settings,
  sliders: SlidersHorizontal,
  key: KeyRound,
  bell: Bell,
  phone: Smartphone,
  image: Image,
  trash: Trash2,
  info: Info,
  refresh: RefreshCw,
  download: Download,
  copy: Copy,
  /* window controls & toggles */
  pane: PanelLeft,
  moon: Moon,
  sun: Sun,
  minus: Minus,
  square: Square,
  stack: SquareStack,
  close: X,
  plus: Plus,
  /* the tab tile glyph: a shell prompt, which is what a pane actually is */
  prompt: Terminal,
  /* bullet for the agent chip and other inline markers */
  diamond: Diamond,
  columns: Columns2,
};

export type IconName = keyof typeof NODES;

/* render one glyph at an explicit size — for the few surfaces whose icon is
   not the 14px default */
export const icon = (name: IconName, size: number): string => svg(NODES[name], size);

/* Sizes that predate the switch to Lucide and that layout depends on: the
   chevron sits inside 12px menu rows, and the chip diamond is a bullet, not a
   button glyph. Everything else is the 14px default. */
const SIZE: Partial<Record<IconName, number>> = {
  chev: 12,
  plus: 12,
  close: 12,
  diamond: 9,
};

export const IC: Record<IconName, string> = Object.fromEntries(
  (Object.entries(NODES) as Array<[IconName, IconNode]>)
    .map(([name, node]) => [name, svg(node, SIZE[name] ?? 14)]),
) as Record<IconName, string>;

/* Kept as a named export because `components/chip.ts` imports it directly;
   it is the same diamond the Lucide set draws, at chip size. */
export const DIA = IC.diamond;

export const ic = (name: IconName): HTMLElement => markup('span', { class: 'ic' }, IC[name]);
