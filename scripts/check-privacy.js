#!/usr/bin/env node
// Privacy scanner. Zero dependencies. See docs/SPEC.md → "Privacy guard".
//
// Modes (exactly one):
//   --staged               added lines of the staged diff, plus staged file paths
//   --range <a>..<b>       every commit in the range: author/committer emails,
//                          message, diff. An all-zero <a> means "all history of <b>".
//   --new-commits <sha>    commits reachable from <sha> that are on no remote ref
//                          (used by the pre-push hook for new branches)
//   --tree                 every tracked or untracked-but-not-ignored file
//   --stdin                text from stdin (PR bodies, commit messages, ...)
//   --identity             the author/committer identity git would use right now
//   --tag <sha>            an annotated tag object: tagger email and message
// Modifier for --stdin:
//   --commit-message       treat stdin as a commit message: also flag CI-skip
//                          markers
//   --cut-scissors         (with --commit-message) ignore everything from the
//                          `git commit -v` scissors line; only for the hook
//
// Output is `location  category` only. The matched text is never printed, so the
// scanner cannot leak what it finds. Exit codes: 0 clean, 1 findings, 2 error.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---- Configuration ----

const ALLOWED_EMAILS = new Set([
  '34960897+niklasjohannes@users.noreply.github.com',
  'noreply@github.com',
  'noreply@anthropic.com',
  'git@github.com',
]);

// `*@example.com` / `*@example.org` are tolerated only inside the scanner's own
// test fixtures, identified by repo-relative path.
const FIXTURE_FILES = new Set(['test/check-privacy.test.js']);
const FIXTURE_EMAIL_DOMAINS = new Set(['example.com', 'example.org']);

// Image names such as `icon@2x.png` look like emails but are not.
const NOT_A_TLD = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'avif']);

// Generic directory names that are placeholders or shared system accounts.
const PLACEHOLDER_HOME_NAMES = new Set([
  'runner', 'user', 'username', 'you', 'me', 'name', 'yourname', 'shared', 'public',
]);

const EMAIL_RE = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g;
// Encoded forms of `@` that would otherwise hide an address.
const ENCODED_AT_RE = /%40|&#0*64;|&#x0*40;|&commat;|\\u0040|\\x40/gi;

// A home directory, with or without a trailing separator. The lookbehind stops
// URLs such as `https://host/users/name` from matching; JSON-escaped Windows
// paths (`C:\\Users\\name`) are covered by the repeated separators.
const HOME_END = '(?=[\\\\/\'"`\\s)\\]},;:]|$)';
const HOME_PATH_RES = [
  new RegExp(`(?<![A-Za-z0-9._#-])\\\\?/(?:Users|home)\\\\?/([A-Za-z0-9._-]+)${HOME_END}`, 'gi'),
  new RegExp(`(?<![A-Za-z0-9])[A-Za-z]:[\\\\/]+Users[\\\\/]+([A-Za-z0-9._-]+)${HOME_END}`, 'gi'),
];

// Credential shapes need realistic lengths, so prefix lists such as `ghp_…` pass.
const CREDENTIAL_RES = [
  /\bgh[pousr]_[A-Za-z0-9]{36,}/,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bmachine\s+\S+\s+login\s+\S+/, // .netrc entry
  /^\s*password\s+\S+\s*$/i, // .netrc password line
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/,
];

// Session links and IDs from local Claude state.
const LOCAL_STATE_CONTENT_RES = [
  /\blocal_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
];

const LOCAL_STATE_PATH_RES = [
  /(^|\/)\.claude\/settings\.local\.json$/,
  /(^|\/)\.claude\/worktrees\//,
  /(^|\/)\.claude\/(projects|transcripts)\//,
  /(^|\/)\.tmp\//,
  /(^|\/)\.netrc$/,
  /(^|\/)\.DS_Store$/,
  /(^|\/)[^/]*transcript[^/]*\.jsonl$/i,
];

// GitHub skips push/PR workflows when a commit message contains one of these.
const CI_SKIP_RE = /\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]|skip-checks:\s*true/i;

// Vendored third-party files (fonts, map data) may carry their authors' emails.
// Entries live in a committed file and apply only while the file's SHA-256
// matches. Only these generic categories can ever be suppressed.
const EXCEPTIONS_FILE = 'scripts/privacy-exceptions.json';
const EXEMPTABLE_CATEGORIES = new Set(['email', 'home-path']);

const ZERO_SHA_RE = /^0+$/;
const MAX_BUFFER = 1024 * 1024 * 1024;

// ---- Helpers ----

/**
 * Run git and return stdout. Throws a generic error (git's own stderr may
 * contain paths or text, so it is never forwarded).
 *
 * @param {string[]} args Arguments after `git`.
 * @param {string} [input] Optional stdin.
 * @returns {string} Standard output.
 */
function git(args, input) {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      input,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    throw new Error(`git ${args[0]} failed`);
  }
}

/**
 * Like `git`, but returns raw bytes.
 *
 * @param {string[]} args Arguments after `git`.
 * @returns {Buffer|null} Standard output, or null when git fails (e.g. no such blob).
 */
function gitBuffer(args) {
  try {
    return execFileSync('git', args, {
      maxBuffer: MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/** @type {Map<string, {sha256: string, categories: Set<string>}>} */
let exceptions = new Map();

/**
 * Load and validate `scripts/privacy-exceptions.json`: an array of
 * `{ path, sha256, reason, categories }`. Throws on a malformed entry or an
 * entry whose path no longer exists. A missing file means no exceptions.
 *
 * @param {string|null} source Where to read it from: null for the working tree,
 *   '' for the index, or a revision. Commit scans use the scanned head, so a
 *   working-tree edit cannot change what a commit is judged against.
 * @returns {void}
 */
function loadExceptions(source) {
  const top = git(['rev-parse', '--show-toplevel']).trim();
  const readPath = (path) => (source === null
    ? (existsSync(join(top, path)) ? readFileSync(join(top, path)) : null)
    : gitBuffer(['show', `${source}:${path}`]));
  const existsAt = (path) => (source === null
    ? existsSync(join(top, path))
    : gitBuffer(['cat-file', '-e', `${source}:${path}`]) !== null);
  const raw = readPath(EXCEPTIONS_FILE);
  exceptions = new Map();
  if (raw === null) return;
  let entries;
  try {
    entries = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error(`${EXCEPTIONS_FILE} is not valid JSON`);
  }
  if (!Array.isArray(entries)) throw new Error(`${EXCEPTIONS_FILE} must be an array`);
  const loaded = new Map();
  entries.forEach((entry, index) => {
    const at = `${EXCEPTIONS_FILE} entry ${index + 1}`;
    if (entry === null || typeof entry !== 'object') throw new Error(`${at} must be an object`);
    const { path, sha256, reason, categories } = entry;
    if (typeof path !== 'string' || path === '') throw new Error(`${at}: \`path\` must be a string`);
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`${at}: \`sha256\` must be 64 lowercase hex characters`);
    }
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new Error(`${at}: \`reason\` must be a non-empty string`);
    }
    if (
      !Array.isArray(categories) || categories.length === 0
      || !categories.every((c) => EXEMPTABLE_CATEGORIES.has(c))
    ) {
      throw new Error(`${at}: \`categories\` must be a non-empty list of email / home-path`);
    }
    if (loaded.has(path)) throw new Error(`${at}: duplicate \`path\``);
    if (!existsAt(path)) throw new Error(`${at}: \`path\` does not exist (stale entry)`);
    loaded.set(path, { sha256, categories: new Set(categories) });
  });
  exceptions = loaded;
}

/**
 * Categories to ignore for a file, given its exact content.
 *
 * @param {string} file Repo-relative path.
 * @param {Buffer|null} content The file's bytes in the state being scanned.
 * @returns {Set<string>|null} Suppressed categories, or null.
 */
function exemptionFor(file, content) {
  const entry = exceptions.get(file);
  if (!entry || content === null) return null;
  const hash = createHash('sha256').update(content).digest('hex');
  return hash === entry.sha256 ? entry.categories : null;
}

/**
 * Load the case-insensitive private literals from `.git/info/private-patterns`
 * (resolved through the common git dir, so linked worktrees work). A missing
 * file, or a directory that is not a repo, yields an empty list. Contents are
 * never printed.
 *
 * @returns {string[]} Lower-cased literals.
 */
function loadPrivatePatterns() {
  let commonDir;
  try {
    commonDir = git(['rev-parse', '--git-common-dir']).trim();
  } catch {
    return [];
  }
  const file = join(commonDir, 'info', 'private-patterns');
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => line.toLowerCase());
  } catch {
    // Fail closed, without a path or stack that could expose anything.
    process.stderr.write('privacy check ERROR: private patterns file is unreadable\n');
    process.exit(2);
  }
}

const PRIVATE_PATTERNS = loadPrivatePatterns();

/**
 * Categorise one line of text.
 *
 * @param {string} text The line.
 * @param {string} file Repo-relative path, or a pseudo-label, for fixture rules.
 * @returns {Set<string>} Categories found (never the matched text).
 */
function categoriseLine(text, file) {
  const found = new Set();
  const isFixture = FIXTURE_FILES.has(file);

  for (const match of text.replace(ENCODED_AT_RE, '@').matchAll(EMAIL_RE)) {
    const email = match[0].toLowerCase();
    const domain = match[1].toLowerCase();
    if (ALLOWED_EMAILS.has(email)) continue;
    if (NOT_A_TLD.has(domain.split('.').pop())) continue;
    if (isFixture && FIXTURE_EMAIL_DOMAINS.has(domain)) continue;
    found.add('email');
  }

  for (const re of HOME_PATH_RES) {
    for (const match of text.matchAll(re)) {
      if (!PLACEHOLDER_HOME_NAMES.has(match[1].toLowerCase())) found.add('home-path');
    }
  }

  if (CREDENTIAL_RES.some((re) => re.test(text))) found.add('credential');
  if (LOCAL_STATE_CONTENT_RES.some((re) => re.test(text))) found.add('local-state');

  if (PRIVATE_PATTERNS.length > 0) {
    const lower = text.toLowerCase();
    if (PRIVATE_PATTERNS.some((p) => lower.includes(p))) found.add('private-pattern');
  }
  return found;
}

/**
 * Collects findings and prints them without ever echoing matched text.
 */
class Report {
  constructor() {
    this.items = [];
    this.seen = new Set();
  }

  /**
   * @param {string} where Location label (file path, commit id, ...).
   * @param {number|null} line 1-based line, or null for whole-item findings.
   * @param {string} category Category slug.
   */
  add(where, line, category) {
    const key = `${where}\u0000${line}\u0000${category}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.items.push({ where, line, category });
  }

  /** @returns {number} Exit code: 0 clean, 1 findings. */
  finish() {
    for (const { where, line, category } of this.items) {
      process.stderr.write(`${where}${line === null ? '' : `:${line}`}  ${category}\n`);
    }
    if (this.items.length > 0) {
      process.stderr.write(`privacy check FAILED: ${this.items.length} finding(s)\n`);
      return 1;
    }
    process.stdout.write('privacy check passed\n');
    return 0;
  }
}

/**
 * A path that itself contains personal text is shown as a placeholder.
 *
 * @param {string} file Path.
 * @returns {string} Path safe to print.
 */
function printable(file) {
  return categoriseLine(file, '').size > 0 ? '<redacted-path>' : file;
}

/**
 * @param {Report} report Findings sink.
 * @param {string} file Repo-relative path.
 * @param {string} [prefix] Prefix for the location label (e.g. a short sha).
 */
function scanPath(report, file, prefix = '') {
  const label = `${prefix}${printable(file)}`;
  if (LOCAL_STATE_PATH_RES.some((re) => re.test(file))) report.add(label, null, 'local-state');
  for (const category of categoriseLine(file, file)) report.add(label, null, category);
}

/**
 * Turn file content into scannable text. Text passes through. Content with NUL
 * bytes (binary, or UTF-16 with or without a BOM) has its NULs removed, which
 * rejoins UTF-16 characters, and is cut into runs of printable ASCII.
 *
 * @param {Buffer} buffer File content.
 * @returns {string} Text to scan.
 */
function decodeContent(buffer) {
  if (!buffer.includes(0)) return buffer.toString('utf8');
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const even = Buffer.from(buffer.subarray(2, 2 + ((buffer.length - 2) & ~1)));
    return even.swap16().toString('utf16le');
  }
  // No BOM: scan NUL-stripped text (catches BOM-less UTF-16) and NUL-split text.
  const split = buffer.toString('latin1').replace(/[^\x20-\x7e\n]+/g, '\n');
  const stripped = Buffer.from(buffer.filter((byte) => byte !== 0));
  return `${stripped.toString('latin1').replace(/[^\x20-\x7e\n]+/g, '\n')}\n${split}`;
}

/**
 * @param {Report} report Findings sink.
 * @param {string} text Multi-line text.
 * @param {string} file Path used for fixture rules.
 * @param {string} label Location label for output.
 * @param {Set<string>|null} [suppress] Categories to ignore (vendored exceptions).
 */
function scanText(report, text, file, label, suppress = null) {
  text.split('\n').forEach((lineText, index) => {
    for (const category of categoriseLine(lineText, file)) {
      if (suppress?.has(category)) continue;
      report.add(label, index + 1, category);
    }
  });
}

/**
 * Scan the added lines of a unified diff (`-U0`) and the paths it touches.
 *
 * @param {Report} report Findings sink.
 * @param {string} diff Diff text.
 * @param {string[]} names Touched paths, in diff order (from `--name-only -z`).
 * @param {string} [prefix] Prefix for location labels.
 * @param {(file: string) => Buffer|null} [readBlob] Content of a file in the scanned state.
 */
function scanDiff(report, diff, names, prefix = '', readBlob = () => null) {
  let file = '';
  let suppress = null;
  let fileIndex = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let newLine = 0;

  for (const raw of diff.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (raw.startsWith('+')) {
        for (const category of categoriseLine(raw.slice(1).replace(/\0/g, ''), file)) {
          if (suppress?.has(category)) continue;
          report.add(`${prefix}${printable(file)}`, newLine, category);
        }
        newLeft -= 1;
        newLine += 1;
      } else if (raw.startsWith('-')) {
        oldLeft -= 1;
      }
      continue;
    }
    if (raw.startsWith('diff --git ')) {
      file = names[fileIndex] ?? '';
      fileIndex += 1;
      suppress = exceptions.has(file) ? exemptionFor(file, readBlob(file)) : null;
      if (file) scanPath(report, file, prefix);
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
      newLine = Number(hunk[2]);
    }
  }
  // A misaligned path list would attribute findings (and exceptions) to the wrong file.
  if (fileIndex !== names.length) throw new Error('diff headers and file list disagree');
}

/**
 * Paths touched by a diff, one per `diff --git` header, in diff order. A
 * typechange (`T`) produces two headers, so its path is listed twice.
 *
 * @param {string[]} args A `git diff` / `git show` invocation without output options.
 * @returns {string[]} Paths.
 */
function listDiffNames(args) {
  const tokens = git([...args, '--raw', '-z', '--no-renames', '--no-abbrev']).split('\0');
  const names = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (!tokens[i].startsWith(':')) continue;
    const status = tokens[i].split(' ')[4] ?? '';
    const path = tokens[i + 1] ?? '';
    names.push(path);
    if (status.startsWith('T')) names.push(path);
    i += 1;
  }
  return names;
}

// `--text` stops `binary`/`-diff` attributes from hiding content; the prefixes are
// pinned so user config (`diff.noprefix`, ...) cannot change the output shape.
const DIFF_ARGS = [
  '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--text', '--no-renames',
  '--src-prefix=a/', '--dst-prefix=b/',
];

// ---- Modes ----

/**
 * @param {Report} report Findings sink.
 */
function scanStaged(report) {
  loadExceptions('');
  const args = ['diff', '--cached', '--diff-filter=ACMRT'];
  const names = listDiffNames(args);
  scanDiff(report, git([...args, ...DIFF_ARGS]), names, '', (file) => gitBuffer(['show', `:${file}`]));
}

/**
 * @param {Report} report Findings sink.
 */
function scanTree(report) {
  loadExceptions(null);
  const files = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0')
    .filter(Boolean);
  for (const file of files) {
    scanPath(report, file);
    let buffer;
    try {
      buffer = readFileSync(file);
    } catch {
      continue; // listed but deleted from the working tree
    }
    scanText(report, decodeContent(buffer), file, printable(file), exemptionFor(file, buffer));
  }
}

/**
 * @param {Report} report Findings sink.
 * @param {string} email Email address from git.
 * @param {string} where Location label.
 * @param {string} category Category slug.
 */
function checkEmail(report, email, where, category) {
  if (!ALLOWED_EMAILS.has(email.trim().toLowerCase())) report.add(where, null, category);
}

/**
 * Scan commits: identities, messages, diffs.
 *
 * @param {Report} report Findings sink.
 * @param {string[]} shas Commit ids.
 */
function scanCommits(report, shas) {
  for (const sha of shas) {
    const short = sha.slice(0, 7);
    const meta = git(['show', '-s', '--no-mailmap', '--format=%ae%n%ce%n%B', sha]);
    const [authorEmail, committerEmail, ...messageLines] = meta.split('\n');
    checkEmail(report, authorEmail, `commit ${short}`, 'author-email');
    checkEmail(report, committerEmail, `commit ${short}`, 'committer-email');

    const message = messageLines.join('\n');
    scanText(report, message, '', `commit ${short} message`);
    if (CI_SKIP_RE.test(message)) report.add(`commit ${short} message`, null, 'ci-skip-marker');

    const showArgs = ['show', '--format=', '--diff-merges=first-parent', '--diff-filter=ACMRT'];
    const names = listDiffNames([...showArgs, sha]);
    scanDiff(report, git([...showArgs, ...DIFF_ARGS, sha]), names, `${short} `, (file) =>
      gitBuffer(['show', `${sha}:${file}`]));
  }
}

/**
 * @param {string} value A revision or range supplied by the caller.
 * @returns {string} The same value, if it cannot be mistaken for a git option.
 */
function assertSafeRev(value) {
  if (!/^[A-Za-z0-9_./~^@{}-]+$/.test(value) || value.startsWith('-')) {
    throw new Error('invalid revision argument');
  }
  return value;
}

/**
 * @param {Report} report Findings sink.
 * @param {string} range `<a>..<b>`.
 */
function scanRange(report, range) {
  const parts = range.split('..');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('`--range` expects <a>..<b>');
  }
  const [from, to] = parts.map(assertSafeRev);
  loadExceptions(to);
  const spec = ZERO_SHA_RE.test(from) ? [to] : [`${from}..${to}`];
  scanCommits(report, git(['rev-list', '--reverse', ...spec]).split('\n').filter(Boolean));
}

/**
 * @param {Report} report Findings sink.
 * @param {string} sha Tip commit.
 */
function scanNewCommits(report, sha) {
  const tip = assertSafeRev(sha);
  loadExceptions(tip);
  scanCommits(
    report,
    git(['rev-list', '--reverse', tip, '--not', '--remotes']).split('\n').filter(Boolean),
  );
}

/**
 * Scan an annotated tag (and any tags it points to): tagger email and message.
 *
 * @param {Report} report Findings sink.
 * @param {string} sha Tag object id.
 */
function scanTag(report, sha) {
  let id = assertSafeRev(sha);
  for (let depth = 0; depth < 10; depth += 1) {
    if (git(['cat-file', '-t', id]).trim() !== 'tag') return;
    const short = id.slice(0, 7);
    const raw = git(['cat-file', 'tag', id]);
    const split = raw.indexOf('\n\n');
    const headers = (split === -1 ? raw : raw.slice(0, split)).split('\n');
    const message = split === -1 ? '' : raw.slice(split + 2);
    const tagger = headers.find((h) => h.startsWith('tagger '));
    const email = tagger?.match(/<([^>]*)>/);
    if (tagger) checkEmail(report, email ? email[1] : '', `tag ${short}`, 'tagger-email');
    scanText(report, message, '', `tag ${short} message`);
    if (CI_SKIP_RE.test(message)) report.add(`tag ${short} message`, null, 'ci-skip-marker');
    id = headers.find((h) => h.startsWith('object '))?.slice(7) ?? '';
    if (!id) return;
  }
  throw new Error('tag chain is too deep');
}

/**
 * @param {Report} report Findings sink.
 */
function scanIdentity(report) {
  for (const [variable, category] of [
    ['GIT_AUTHOR_IDENT', 'author-email'],
    ['GIT_COMMITTER_IDENT', 'committer-email'],
  ]) {
    const match = git(['var', variable]).match(/<([^>]*)>/);
    checkEmail(report, match ? match[1] : '', 'git identity', category);
  }
}

/**
 * @param {Report} report Findings sink.
 * @param {boolean} asCommitMessage Flag CI-skip markers.
 * @param {boolean} cutScissors Ignore everything from the `git commit -v` scissors line.
 */
function scanStdin(report, asCommitMessage, cutScissors) {
  const text = readFileSync(0, 'utf8');
  // `#` lines are scanned: `git commit -m` keeps them. The scissors cut (for the
  // `git commit -v` diff) is opt-in, because anything else, like a PR body, is
  // author-controlled and must be read in full.
  let kept = text;
  if (cutScissors) {
    const scissors = text.search(/^# -{24} >8 -{24}$/m);
    if (scissors !== -1) kept = text.slice(0, scissors);
  }
  scanText(report, kept, '', '<stdin>');
  if (asCommitMessage && CI_SKIP_RE.test(kept)) report.add('<stdin>', null, 'ci-skip-marker');
}

// ---- Entry point ----

const USAGE = `usage: check-privacy.js --staged | --range <a>..<b> | --new-commits <sha> | --tree
       | --tag <sha> | --identity | --stdin [--commit-message [--cut-scissors]]`;

/**
 * @param {string[]} argv Arguments after the script name.
 * @returns {number} Exit code.
 */
function main(argv) {
  const modes = [
    '--staged', '--range', '--new-commits', '--tag', '--tree', '--identity', '--stdin',
  ];
  const used = argv.filter((a) => modes.includes(a));
  const asCommitMessage = argv.includes('--commit-message');
  const cutScissors = argv.includes('--cut-scissors');
  const takesValue = ['--range', '--new-commits', '--tag'];
  const expected = used.length + used.filter((a) => takesValue.includes(a)).length
    + (asCommitMessage ? 1 : 0) + (cutScissors ? 1 : 0);
  const needsStdin = asCommitMessage || cutScissors;
  if (
    used.length !== 1 || argv.length !== expected || (needsStdin && used[0] !== '--stdin')
    || (cutScissors && !asCommitMessage)
  ) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  const mode = used[0];
  const value = argv[argv.indexOf(mode) + 1];
  const report = new Report();
  try {
    if (mode === '--staged') scanStaged(report);
    else if (mode === '--tree') scanTree(report);
    else if (mode === '--identity') scanIdentity(report);
    else if (mode === '--stdin') scanStdin(report, asCommitMessage, cutScissors);
    else if (mode === '--tag') scanTag(report, value);
    else if (mode === '--range') scanRange(report, value);
    else scanNewCommits(report, value);
  } catch (error) {
    process.stderr.write(`privacy check ERROR: ${error.message}\n`);
    return 2;
  }
  return report.finish();
}

process.exitCode = main(process.argv.slice(2));
