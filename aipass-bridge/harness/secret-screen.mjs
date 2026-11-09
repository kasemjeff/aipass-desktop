// @ts-nocheck
// The RUN secret screen, filesystem-aware: secretHit screens the literal
// words, globSecretHit expands the glob words against the real directory
// so a bare `cat *` (or `*.pem`) that reaches a secret file is denied
// too. `grep -r .` names no file at all — no name check can stop it, and
// the output screen (scrubOutput) is the defence there. Values are cached
// per run and stay in memory only.
import fs from 'node:fs';
import path from 'node:path';
import { secretHit, globMatch } from './permissions.mjs';
import { collectProjectSecretValues } from './output-scrub.mjs';

const SECRET_TOKEN_SPLIT = /[\s'";&|<>()\[\]{}$`=:\-]+/;

export function createSecretScreen({ root, overlay }) {
  let knownSecrets = null;
  const getKnownSecrets = async () => {
    if (knownSecrets) return knownSecrets;
    try { knownSecrets = await collectProjectSecretValues(root); } catch { knownSecrets = []; }
    return knownSecrets;
  };
  const globSecretHit = async (text) => {
    const direct = secretHit(text);
    if (direct) return direct;
    const tokens = String(text ?? '').replace(/\\/g, '/').split(SECRET_TOKEN_SPLIT).filter(Boolean);
    for (const token of tokens) {
      if (!/[*?[\]]/.test(token)) continue;
      const slash = token.lastIndexOf('/');
      const dirPart = slash >= 0 ? token.slice(0, slash) : '.';
      const basePat = slash >= 0 ? token.slice(slash + 1) : token;
      if (!basePat.includes('*') && !basePat.includes('?') && !basePat.includes('[')) continue;
      if (dirPart.includes('*') || dirPart.includes('?') || dirPart.includes('[')) continue;
      let dirAbs;
      try { dirAbs = overlay.trySafe(dirPart === '.' ? '.' : dirPart) ?? path.join(root, dirPart); } catch { continue; }
      if (!dirAbs) continue;
      let entries;
      try { entries = await fs.promises.readdir(dirAbs); } catch { continue; }
      for (const name of entries) {
        if (!globMatch(basePat.split('?').join('*'), name)) continue;
        const candidate = dirPart === '.' ? name : dirPart + '/' + name;
        const hit = secretHit(candidate);
        if (hit) return { token, pattern: hit.pattern, expanded: candidate };
      }
    }
    return null;
  };
  return { getKnownSecrets, globSecretHit };
}

// CREATE over an existing file keeps its shape: CRLF stays CRLF and a
// leading BOM (Thai-first .ps1/CSV on Windows need it) is re-added when
// the new body lost it. The overlay is the only write surface, so this
// is where the shape is kept.
export function preserveFileShape(existing, body) {
  if (existing === null || typeof body !== 'string') return body;
  let out = body;
  if (/\r\n/.test(existing) && !/\r\n/.test(out)) out = out.replace(/\n/g, '\r\n');
  if (existing.startsWith('\uFEFF') && !out.startsWith('\uFEFF')) out = '\uFEFF' + out;
  return out;
}

// Does this file's bytes carry a known secret value verbatim? ATTACH
// sends bytes upstream, so a renamed copy (`cp .env data.txt`) must not
// ride it under an innocent name. Plaintext only: a compressed archive
// is gated at creation (classifyRun) instead.
export function containsKnownSecret(buffer, secrets) {
  if (!secrets?.length || !buffer?.length) return false;
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  return secrets.some((s) => typeof s === 'string' && s.length >= 6 && text.includes(s));
}
