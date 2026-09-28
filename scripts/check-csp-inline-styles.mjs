/* Guards the CSP invariant that the renderer depends on: style-src must stay
   nonce-free, because both xterm (a <style> element per terminal) and the
   palette swatches (a style="" attribute per dot) inject styles at runtime.

   Tauri stamps `nonce="__TAURI_STYLE_NONCE__"` onto every inline <style> in
   the HTML (tauri-utils html2::inject_nonce_token) and appends a real
   'nonce-…' source to style-src on every response. Per the CSP spec a
   directive that carries a nonce- or hash-source IGNORES 'unsafe-inline' —
   so the moment src/index.html grew its first inline <style> (the boot
   splash, v0.2.32) every runtime-injected style in the app started being
   refused, silently. Dev never showed it: devCsp has no style-src at all, so
   style-src falls back to default-src, which has no nonce either.

   That failure is invisible until a pane is open: no error in the terminal,
   only a terminal with no colours and no cell metrics, and palette swatches
   rendered as empty 14px boxes. `npm run check:csp-inline-styles` is the
   tripwire. Exits non-zero on the first violation. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const security = conf.app?.security ?? {};
const problems = [];

/* Tauri's DisabledCspModificationKind takes true, or a list of directives. */
const disabled = security.dangerousDisableAssetCspModification;
const styleSrcLocked = disabled === true || (Array.isArray(disabled) && disabled.includes('style-src'));

for (const key of ['csp', 'devCsp']) {
  const policy = security[key];
  if (!policy) continue;
  for (const directive of policy.split(';').map((d) => d.trim()).filter(Boolean)) {
    const [name, ...sources] = directive.split(/\s+/);
    if (name !== 'style-src' && name !== 'style-src-elem' && name !== 'style-src-attr') continue;
    if (!sources.includes("'unsafe-inline'")) continue;
    if (styleSrcLocked) continue;
    problems.push(
      `${key}: ${name} carries 'unsafe-inline' but Tauri is still allowed to stamp a nonce into style-src.\n`
      + "    The nonce makes 'unsafe-inline' inert, so xterm's runtime <style> elements and every\n"
      + "    style=\"\" attribute (the palette swatches) get refused. Set\n"
      + '    security.dangerousDisableAssetCspModification to ["style-src"].',
    );
  }
}

/* script-src must keep its nonces: that is the directive that actually stops
   script injection, and losing it is a real security downgrade rather than a
   rendering bug. */
if (disabled === true) {
  problems.push('dangerousDisableAssetCspModification is true — that also strips script-src nonces. Scope it to ["style-src"].');
}

if (problems.length) {
  for (const p of problems) console.error('FAIL ' + p + '\n');
  process.exit(1);
}
console.log('ok: style-src stays nonce-free, script-src keeps its nonces');
