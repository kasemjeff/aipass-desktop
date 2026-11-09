// @ts-check
// What a command printed, before it becomes part of the transcript.
//
// A RUN is the machine's mouth. `set` (Windows) and `env` (POSIX) print the
// whole environment, a command may echo a token it read out of a config file,
// and the transcript is what goes upstream to the model — so anything a command
// prints can leave the machine. The command itself is screened for secret
// FILES (permissions.mjs); its OUTPUT is screened here, in two shapes:
//
//   - a known token by its own shape (`sk-…`, `ghp_…`, `AKIA…`, `Bearer …`) —
//     the same list the bridge scrubs out of its logs;
//   - an assignment whose NAME says it carries a credential (`API_KEY=…`,
//     `GITHUB_TOKEN=…`, `?_authToken=…`) — the shape an environment dump and
//     most config files have.
//
// Both are redactions, not refusals: the command still ran, the transcript
// still says what happened, and the value never leaves.
import { scrubSecrets } from '../bridge/log-scrub.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

/** The words a variable name is made of when it carries a credential. */
const SECRET_WORDS = new Set([
  'pass', 'passwd', 'pwd', 'password', 'secret', 'token', 'key', 'keys',
  'credential', 'credentials', 'auth', 'authorization', 'cookie', 'session',
  'passphrase', 'apikey', 'secretkey', 'privatekey', 'accesskey',
  'jwt', 'bearer', 'pat',
]);

/**
 * The words of a name: split on the separators AND on camelCase, so
 * `_authToken` is `auth` + `token` and `AWS_SECRET_ACCESS_KEY` is `aws` +
 * `secret` + `access` + `key`. A name that merely contains a word (`MONKEY`)
 * is not one — the split is what keeps it honest.
 */
/** @param {any} name */
const wordsOf = (name) => String(name)
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .split(/[^A-Za-z0-9]+/)
  .filter(Boolean)
  .map((w) => w.toLowerCase());

/** Does this variable name say it carries a credential? */
/** @param {any} name */
export function isSecretName(name) {
  return wordsOf(name).some((w) => SECRET_WORDS.has(w));
}

// `name=value`, wherever it sits in a line: an environment dump, a config
// file, a query string. The value stops at whitespace or an `&`, so a URL
// with two parameters is screened twice, not once. Quoted values are
// whole ("hunter2", 'abc123def456') — the quotes are part of the match
// so the value never survives on either side of the redaction.
const ASSIGN = /(\b[A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s&"'`]+)/g;
// `key: value` at line start only (YAML / JSON): `password: x`,
// `"password": "x"`. Anchored to the line start so prose like
// "Press any key: to continue" is never touched — only a name at the
// start of a line counts as a key.
const KEYLINE = /^(\s*[-{[]?\s*["']?)([A-Za-z_][A-Za-z0-9_.-]*)(["']?\s*:\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,#][^\n,#]*)/gm;
// The password in `postgres://user:pass@host`: everything between the
// first `:` after the userinfo and the `@` goes.
const USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;

/**
 * Screen a command's output: the token shapes first, then the embedded
 * password, the assignments and the keys whose name carries a credential.
 * `knownSecrets` are literal values read from the project's own secret
 * files (see collectProjectSecretValues) — they are redacted wherever
 * they appear, whatever the surrounding syntax, because a value an
 * observer saw in a .env file is a secret even when it prints bare.
 * @param {any} text
 * @param {any} [knownSecrets]
 */
export function scrubOutput(text, knownSecrets = null) {
  if (typeof text !== 'string' || !text) return text;
  let out = scrubSecrets(text);
  out = out.replace(USERINFO, '$1[redacted]@');
  out = out.replace(ASSIGN, (whole, name, sep) => (
    isSecretName(name) ? `${name}${sep}[redacted]` : whole
  ));
  out = out.replace(KEYLINE, (whole, pre, name, sep) => (
    isSecretName(name) ? `${pre}${name}${sep}[redacted]` : whole
  ));
  if (knownSecrets) {
    const secrets = [...knownSecrets]
      .filter((s) => typeof s === 'string' && s.length >= 6)
      .sort((a, b) => b.length - a.length);
    for (const secret of secrets) {
      if (secret && out.includes(secret)) out = out.split(secret).join('[redacted]');
    }
  }
  return out;
}

/** Clean one value out of a .env / YAML / JSON line: strip quotes and a
 * trailing comment/comma, so `DB_PASSWORD="hunter2"` yields hunter2. */
const cleanValue = (/** @type {any} */ raw) => {
  let v = String(raw ?? '').trim();
  if (!v) return '';
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  const quote = v[0];
  if (quote === '"' || quote === "'") {
    const close = v.indexOf(quote, 1);
    if (close > 0) return v.slice(1, close);
  }
  v = v.split(/\s+#/)[0].split(',')[0].trim();
  return v.replace(/^["']|["']$/g, '');
};

/** The secret values one file's text carries: every assignment or key
 * whose name says it is a credential, cleaned and kept when long enough
 * to be a secret (below 6 it is a number or a word, not a credential). */
const valuesInText = (/** @type {string} */ text) => {
  const found = new Set();
  const re = /^\s*(?:export\s+)?["']?([A-Za-z_][A-Za-z0-9_.-]*?)["']?\s*(?:=|:)\s*(.+)$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, name, raw] = m;
    if (!isSecretName(name)) continue;
    const value = cleanValue(raw);
    if (value.length >= 6) found.add(value);
  }
  return found;
};

/**
 * Read the project's .env files and return their secret values, in memory
 * only. The walk is shallow (the root and two levels down) and bounded, so
 * a RUN pays one small listing — the values themselves never leave this
 * process. They are what scrubOutput redacts a bare value against: a
 * command that prints a value without its name (`echo hunter2`) is
 * screened exactly like one that prints the assignment.
 * @param {any} root
 * @returns {Promise<string[]>}
 */
export async function collectProjectSecretValues(root) {
  const values = new Set();
  if (root == null || root === '') return [];
  const MAX_VISITED = 5000;
  let visited = 0;
  const SKIP_DIRS = new Set(['.git', 'node_modules', '.aipass', 'dist', 'build', '.next', 'target', '__pycache__']);
  const walk = async (/** @type {string} */ dir, /** @type {number} */ depth) => {
    if (depth > 2 || visited >= MAX_VISITED) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (visited >= MAX_VISITED) return;
      visited++;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (!e.name.startsWith('.env')) continue;
      try {
        const st = await fs.stat(full);
        if (st.size > 64 * 1024) continue;
        const text = await fs.readFile(full, 'utf8');
        for (const v of valuesInText(text)) values.add(v);
      } catch { /* an unreadable env file is not a redaction failure */ }
    }
  };
  try {
    const a = String(root);
    if (a) await walk(path.resolve(a), 0);
  } catch { /* the root is not a directory — no values to carry */ }
  return [...values].sort((x, y) => y.length - x.length);
}
