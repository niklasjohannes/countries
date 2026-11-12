import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-privacy.js');

// Allowed identity used by the throwaway repos.
const GOOD_EMAIL = '34960897+niklasjohannes@users.noreply.github.com';
// example.com is tolerated only in this file; in a throwaway repo it is NOT
// allowlisted, so it stands in for "some personal address".
const BAD_EMAIL = 'someone@example.com';

// Fake secrets and paths are assembled at runtime so that this file's own source
// never contains a complete match.
const FAKE_NAME = 'fake' + 'person';
const fakeToken = (prefix, length) => prefix + 'a1B2c3D4e5'.repeat(8).slice(0, length);

const CLEAN_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_COMMITTER_NAME: 'Test',
  GIT_AUTHOR_EMAIL: GOOD_EMAIL,
  GIT_COMMITTER_EMAIL: GOOD_EMAIL,
};

/** Run the scanner. `env` entries override the clean environment. */
function scan(args, { cwd = REPO_ROOT, input, env = {} } = {}) {
  const result = spawnSync('node', [SCRIPT, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: { ...CLEAN_ENV, ...env },
  });
  return { status: result.status, out: result.stdout + result.stderr };
}

/** Run git in a directory and return trimmed stdout; throws on failure. */
function git(cwd, args, env = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...CLEAN_ENV, ...env } });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

const roots = [];

/** Create a throwaway repo with the allowed identity configured. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'privacy-test-'));
  roots.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'user.email', GOOD_EMAIL]);
  return dir;
}

/** Write a file, commit it, and return the new commit id. */
function commitFile(dir, name, content, message = 'add file', env = {}) {
  const path = join(dir, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  git(dir, ['add', '-f', name]);
  git(dir, ['commit', '-q', '-m', message], env);
  return git(dir, ['rev-parse', 'HEAD']);
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function assertFails(result, category) {
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, new RegExp(`\\s${category}\\n`));
}

describe('--stdin: categories', () => {
  const cases = [
    ['email', `contact ${BAD_EMAIL} please`],
    ['email', `contact someone@${'example'}.net please`],
    ['home-path', `see /Users/${FAKE_NAME}/code`],
    ['home-path', `see /home/${FAKE_NAME}/code`],
    ['home-path', `see C:\\Users\\${FAKE_NAME}\\code`],
    ['credential', `token ${fakeToken('ghp_', 36)}`],
    ['credential', `token ${fakeToken('github_pat_', 40)}`],
    ['credential', `key ${fakeToken('sk-ant-', 30)}`],
    ['credential', 'key AKIA' + 'ABCDEFGHIJKLMNOP'],
    ['credential', ['mach' + 'ine', 'host.invalid', 'login', 'someone'].join(' ')],
    ['credential', '-----BEGIN ' + 'RSA PRIVATE KEY-----'],
    ['local-state', 'link local_' + '0a1b2c3d-0a1b-0a1b-0a1b-0a1b2c3d4e5f'],
  ];

  cases.forEach(([category, text], index) => {
    it(`flags ${category} (case ${index + 1})`, () => {
      const result = scan(['--stdin'], { input: `line one\n${text}\n` });
      assertFails(result, category);
      assert.match(result.out, /<stdin>:2 /);
    });
  });

  it('never prints the matched text', () => {
    const secret = fakeToken('ghp_', 36);
    const text = `a ${BAD_EMAIL} b /Users/${FAKE_NAME}/x ${secret}`;
    const result = scan(['--stdin'], { input: text });
    assert.equal(result.status, 1);
    for (const needle of [BAD_EMAIL, 'someone', 'example.com', FAKE_NAME, secret, 'ghp_']) {
      assert.ok(!result.out.includes(needle), `output leaked ${needle.length} chars`);
    }
  });

  it('passes the allowlisted emails', () => {
    const text = [GOOD_EMAIL, 'noreply@github.com', 'noreply@anthropic.com', 'git@github.com']
      .join('\n');
    assert.equal(scan(['--stdin'], { input: text }).status, 0);
  });

  it('passes email-like text that is not an email', () => {
    const text = [
      'uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'react@18.3.1',
      'icon@2x.png',
      'npm i @types/node',
    ].join('\n');
    assert.equal(scan(['--stdin'], { input: text }).status, 0);
  });

  it('passes placeholder paths and incomplete credential prefixes', () => {
    const text = [
      '/Users/<name>/ and /home/<name>/',
      '/home/runner/work and /Users/Shared/',
      'prefixes: ghp_… github_pat_… sk-ant-… AKIA…',
      'a password policy applies',
      'uses https://host.invalid/users/someone and #/home/page',
    ].join('\n');
    assert.equal(scan(['--stdin'], { input: text }).status, 0);
  });

  it('does not allow example.com outside the scanner fixtures', () => {
    // The throwaway repo is not the fixture path, and --stdin has no path.
    assertFails(scan(['--stdin'], { input: 'a@example.org' }), 'email');
  });
});

describe('--stdin --commit-message', () => {
  it('scans `#` lines, which `git commit -m` keeps', () => {
    const text = `subject\n\n# note ${BAD_EMAIL}\n`;
    assertFails(scan(['--stdin', '--commit-message'], { input: text }), 'email');
  });

  it('stops at the `git commit -v` scissors line', () => {
    const scissors = `# ${'-'.repeat(24)} >8 ${'-'.repeat(24)}`;
    const text = `subject\n\n${scissors}\n+${BAD_EMAIL}\n`;
    assert.equal(scan(['--stdin', '--commit-message'], { input: text }).status, 0);
  });

  it('flags CI-skip markers, but only for messages', () => {
    const text = 'subject [skip ci]\n';
    assertFails(scan(['--stdin', '--commit-message'], { input: text }), 'ci-skip-marker');
    assert.equal(scan(['--stdin'], { input: text }).status, 0);
  });
});

describe('private patterns', () => {
  let repo;
  before(() => {
    repo = makeRepo();
    writeFileSync(
      join(repo, '.git', 'info', 'private-patterns'),
      '# comment line\n\nFake-Secret-Term\n  another fake literal  \n',
    );
  });

  it('flags a literal case-insensitively', () => {
    const result = scan(['--stdin'], { cwd: repo, input: 'x FAKE-secret-TERM y' });
    assertFails(result, 'private-pattern');
    assert.ok(!/secret/i.test(result.out));
  });

  it('trims lines and ignores comments and blank lines', () => {
    assertFails(scan(['--stdin'], { cwd: repo, input: 'has Another Fake Literal' }), 'private-pattern');
    assert.equal(scan(['--stdin'], { cwd: repo, input: 'a comment line here' }).status, 0);
  });

  it('is skipped silently when the file is missing', () => {
    const other = makeRepo();
    assert.equal(scan(['--stdin'], { cwd: other, input: 'fake-secret-term' }).status, 0);
  });

  it('is found from a linked worktree', () => {
    commitFile(repo, 'a.txt', 'hello\n');
    const linked = join(repo, '..', `linked-${Date.now()}`);
    roots.push(linked);
    git(repo, ['worktree', 'add', '-q', '-b', 'side', linked]);
    assertFails(scan(['--stdin'], { cwd: linked, input: 'fake-secret-term' }), 'private-pattern');
  });

  it('applies to files in --tree mode', () => {
    writeFileSync(join(repo, 'notes.txt'), 'ok\nthe fake-secret-term\n');
    const result = scan(['--tree'], { cwd: repo });
    assertFails(result, 'private-pattern');
    assert.match(result.out, /notes\.txt:2 /);
  });
});

describe('--staged', () => {
  it('flags an added line with file:line and category only', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.md'), `one\ntwo\ncontact ${BAD_EMAIL}\n`);
    git(repo, ['add', 'a.md']);
    const result = scan(['--staged'], { cwd: repo });
    assertFails(result, 'email');
    assert.match(result.out, /^a\.md:3 {2}email$/m);
    assert.ok(!result.out.includes('someone'));
  });

  it('reports lines correctly after an earlier hunk', () => {
    const repo = makeRepo();
    commitFile(repo, 'a.md', 'x\n'.repeat(10));
    writeFileSync(join(repo, 'a.md'), `y\n${'x\n'.repeat(8)}-- /Users/${FAKE_NAME}/z\nx\n`);
    git(repo, ['add', 'a.md']);
    assert.match(scan(['--staged'], { cwd: repo }).out, /^a\.md:10 {2}home-path$/m);
  });

  it('ignores removed lines and passes clean content', () => {
    const repo = makeRepo();
    commitFile(repo, 'a.md', `${BAD_EMAIL}\n`, 'add', { GIT_AUTHOR_EMAIL: GOOD_EMAIL });
    writeFileSync(join(repo, 'a.md'), 'clean\n');
    git(repo, ['add', 'a.md']);
    assert.equal(scan(['--staged'], { cwd: repo }).status, 0);
  });

  it('flags local Claude state by path', () => {
    const repo = makeRepo();
    for (const name of ['.tmp/body.md', '.claude/settings.local.json', '.claude/worktrees/x/f.txt']) {
      mkdirSync(join(repo, name, '..'), { recursive: true });
      writeFileSync(join(repo, name), 'harmless\n');
      git(repo, ['add', '-f', name]);
    }
    const result = scan(['--staged'], { cwd: repo });
    assertFails(result, 'local-state');
    assert.equal((result.out.match(/local-state/g) ?? []).length, 3);
  });
});

describe('--tree', () => {
  it('scans untracked files but not ignored ones', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n');
    writeFileSync(join(repo, 'ignored.txt'), `${BAD_EMAIL}\n`);
    writeFileSync(join(repo, 'seen.txt'), `ok\n${BAD_EMAIL}\n`);
    const result = scan(['--tree'], { cwd: repo });
    assert.match(result.out, /^seen\.txt:2 {2}email$/m);
    assert.ok(!result.out.includes('ignored.txt'));
  });

  it('scans binary and UTF-16 content', () => {
    const repo = makeRepo();
    const line = `x ${BAD_EMAIL}\n`;
    writeFileSync(join(repo, 'b.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(line)]));
    writeFileSync(join(repo, 'le.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(line, 'utf16le')]));
    writeFileSync(join(repo, 'be.txt'), Buffer.from(line, 'utf16le').swap16());
    const result = scan(['--tree'], { cwd: repo });
    for (const name of ['b.bin', 'le.txt', 'be.txt']) {
      assert.match(result.out, new RegExp(`^${name.replace('.', '\\.')}:\\d+ {2}email$`, 'm'), name);
    }
  });

  it('passes the real repository', () => {
    const result = scan(['--tree']);
    assert.equal(result.status, 0, result.out);
  });
});

describe('--range and --new-commits', () => {
  it('fails on a non-allowlisted author email', () => {
    const repo = makeRepo();
    const base = commitFile(repo, 'a.txt', 'one\n');
    commitFile(repo, 'b.txt', 'two\n', 'second', { GIT_AUTHOR_EMAIL: BAD_EMAIL });
    const result = scan(['--range', `${base}..HEAD`], { cwd: repo });
    assertFails(result, 'author-email');
    assert.ok(!result.out.includes('someone'));
  });

  it('fails on a non-allowlisted committer email', () => {
    const repo = makeRepo();
    const base = commitFile(repo, 'a.txt', 'one\n');
    commitFile(repo, 'b.txt', 'two\n', 'second', { GIT_COMMITTER_EMAIL: BAD_EMAIL });
    assertFails(scan(['--range', `${base}..HEAD`], { cwd: repo }), 'committer-email');
  });

  it('passes allowlisted identities and clean content', () => {
    const repo = makeRepo();
    const base = commitFile(repo, 'a.txt', 'one\n');
    commitFile(repo, 'b.txt', 'two\n', 'second', {
      GIT_AUTHOR_EMAIL: 'noreply@github.com',
      GIT_COMMITTER_EMAIL: 'noreply@github.com',
    });
    assert.equal(scan(['--range', `${base}..HEAD`], { cwd: repo }).status, 0);
  });

  it('flags a message with personal text', () => {
    const repo = makeRepo();
    const base = commitFile(repo, 'a.txt', 'one\n');
    commitFile(repo, 'b.txt', 'two\n', `note ${BAD_EMAIL}`);
    assert.match(scan(['--range', `${base}..HEAD`], { cwd: repo }).out, /message:1 {2}email/);
  });

  it('flags a CI-skip marker in a commit message', () => {
    const repo = makeRepo();
    const base = commitFile(repo, 'a.txt', 'one\n');
    commitFile(repo, 'b.txt', 'two\n', 'tweak [skip ci]');
    assertFails(scan(['--range', `${base}..HEAD`], { cwd: repo }), 'ci-skip-marker');
  });

  it('catches a leak that a later commit removed', () => {
    const repo = makeRepo();
    const base = commitFile(repo, 'a.txt', 'one\n');
    commitFile(repo, 'a.txt', `${BAD_EMAIL}\n`, 'leak');
    commitFile(repo, 'a.txt', 'clean\n', 'fix');
    const result = scan(['--range', `${base}..HEAD`], { cwd: repo });
    assertFails(result, 'email');
    assert.match(result.out, /^[0-9a-f]{7} a\.txt:1 {2}email$/m);
  });

  it('treats an all-zero start as the whole history', () => {
    const repo = makeRepo();
    commitFile(repo, 'a.txt', 'one\n', 'first', { GIT_AUTHOR_EMAIL: BAD_EMAIL });
    const head = git(repo, ['rev-parse', 'HEAD']);
    assertFails(scan(['--range', `${'0'.repeat(40)}..${head}`], { cwd: repo }), 'author-email');
  });

  it('rejects malformed ranges and option-like revisions with exit 2', () => {
    const repo = makeRepo();
    commitFile(repo, 'a.txt', 'one\n');
    assert.equal(scan(['--range', 'HEAD'], { cwd: repo }).status, 2);
    assert.equal(scan(['--range', '--output=x..HEAD'], { cwd: repo }).status, 2);
    assert.equal(scan(['--range', 'nope..HEAD'], { cwd: repo }).status, 2);
  });

  it('--new-commits skips commits already on a remote ref', () => {
    const repo = makeRepo();
    const pushed = commitFile(repo, 'a.txt', 'one\n', 'first', { GIT_AUTHOR_EMAIL: BAD_EMAIL });
    git(repo, ['update-ref', 'refs/remotes/origin/main', pushed]);
    commitFile(repo, 'b.txt', 'two\n');
    assert.equal(scan(['--new-commits', 'HEAD'], { cwd: repo }).status, 0);
    commitFile(repo, 'c.txt', 'three\n', 'third', { GIT_AUTHOR_EMAIL: BAD_EMAIL });
    assertFails(scan(['--new-commits', 'HEAD'], { cwd: repo }), 'author-email');
  });
});

describe('--identity and usage', () => {
  it('passes the allowed identity and fails any other', () => {
    const repo = makeRepo();
    assert.equal(scan(['--identity'], { cwd: repo }).status, 0);
    assertFails(scan(['--identity'], { cwd: repo, env: { GIT_AUTHOR_EMAIL: BAD_EMAIL } }), 'author-email');
    assertFails(
      scan(['--identity'], { cwd: repo, env: { GIT_COMMITTER_EMAIL: BAD_EMAIL } }),
      'committer-email',
    );
  });

  it('exits 2 on bad usage', () => {
    for (const args of [[], ['--tree', '--staged'], ['--bogus'], ['--tree', '--commit-message']]) {
      assert.equal(scan(args).status, 2, args.join(' '));
    }
  });
});

describe('git hooks', () => {
  /** A throwaway repo with the real scripts and hooks, hooks activated. */
  function makeHookedRepo() {
    const repo = makeRepo();
    cpSync(join(REPO_ROOT, 'scripts', 'check-privacy.js'), join(repo, 'scripts', 'check-privacy.js'));
    cpSync(join(REPO_ROOT, '.githooks'), join(repo, '.githooks'), { recursive: true });
    git(repo, ['config', 'core.hooksPath', '.githooks']);
    return repo;
  }

  it('pre-commit blocks personal staged content and a bad identity', () => {
    const repo = makeHookedRepo();
    writeFileSync(join(repo, 'a.txt'), `${BAD_EMAIL}\n`);
    git(repo, ['add', 'a.txt']);
    assert.throws(() => git(repo, ['commit', '-q', '-m', 'x']));
    writeFileSync(join(repo, 'a.txt'), 'clean\n');
    git(repo, ['add', 'a.txt']);
    assert.throws(() => git(repo, ['commit', '-q', '-m', 'x'], { GIT_AUTHOR_EMAIL: BAD_EMAIL }));
    git(repo, ['commit', '-q', '-m', 'x']);
  });

  it('commit-msg blocks personal text in the message', () => {
    const repo = makeHookedRepo();
    writeFileSync(join(repo, 'a.txt'), 'clean\n');
    git(repo, ['add', 'a.txt']);
    assert.throws(() => git(repo, ['commit', '-q', '-m', `mail ${BAD_EMAIL}`]));
    assert.throws(() => git(repo, ['commit', '-q', '-m', 'oops [skip ci]']));
  });

  it('pre-push blocks bad commits, allows clean ones', () => {
    const repo = makeHookedRepo();
    const remote = mkdtempSync(join(tmpdir(), 'privacy-remote-'));
    roots.push(remote);
    git(remote, ['init', '-q', '--bare', '-b', 'main']);
    git(repo, ['remote', 'add', 'origin', remote]);

    writeFileSync(join(repo, 'a.txt'), 'clean\n');
    git(repo, ['add', 'a.txt']);
    git(repo, ['commit', '-q', '-m', 'good']);
    git(repo, ['push', '-q', 'origin', 'main']);

    // Bypass the commit-time hooks to simulate a bad commit that slipped in.
    writeFileSync(join(repo, 'b.txt'), 'more\n');
    git(repo, ['add', 'b.txt']);
    git(repo, ['commit', '-q', '--no-verify', '-m', 'bad'], { GIT_AUTHOR_EMAIL: BAD_EMAIL });
    assert.throws(() => git(repo, ['push', '-q', 'origin', 'main']));
    assert.throws(() => git(repo, ['push', '-q', 'origin', 'main:other']));

    git(repo, ['reset', '-q', '--hard', 'HEAD~1']);
    writeFileSync(join(repo, 'c.txt'), 'fine\n');
    git(repo, ['add', 'c.txt']);
    git(repo, ['commit', '-q', '-m', 'good two']);
    git(repo, ['push', '-q', 'origin', 'main']);
  });
});

describe('review fixes: false negatives', () => {
  const stage = (repo, name, content) => {
    mkdirSync(join(repo, name, '..'), { recursive: true });
    writeFileSync(join(repo, name), content);
    git(repo, ['add', '-f', name]);
  };

  it('flags personal text in a file name, in every mode', () => {
    const repo = makeRepo();
    const base = commitFile(repo, 'a.txt', 'one\n');
    const name = `${BAD_EMAIL}.txt`;
    stage(repo, name, 'harmless\n');
    const staged = scan(['--staged'], { cwd: repo });
    assertFails(staged, 'email');
    assert.ok(!staged.out.includes('someone'));
    assert.match(staged.out, /<redacted-path> {2}email/);
    git(repo, ['commit', '-q', '-m', 'add']);
    assertFails(scan(['--range', `${base}..HEAD`], { cwd: repo }), 'email');
    assertFails(scan(['--tree'], { cwd: repo }), 'email');
  });

  it('flags NUL-containing content in staged and range diffs', () => {
    const repo = makeRepo();
    const base = commitFile(repo, 'a.txt', 'one\n');
    writeFileSync(join(repo, '.gitattributes'), '*.dat binary\n*.u16 -diff\n');
    git(repo, ['add', '.gitattributes']);
    const line = `x ${BAD_EMAIL}\n`;
    stage(repo, 'p.dat', Buffer.concat([Buffer.from([0, 1]), Buffer.from(line)]));
    stage(repo, 'q.u16', Buffer.from(line, 'utf16le'));
    const staged = scan(['--staged'], { cwd: repo });
    assert.match(staged.out, /^p\.dat:\d+ {2}email$/m);
    assert.match(staged.out, /^q\.u16:\d+ {2}email$/m);
    git(repo, ['commit', '-q', '-m', 'add']);
    const range = scan(['--range', `${base}..HEAD`], { cwd: repo });
    assert.match(range.out, /p\.dat:\d+ {2}email$/m);
    assert.match(range.out, /q\.u16:\d+ {2}email$/m);
  });

  it('flags .DS_Store by path', () => {
    const repo = makeRepo();
    stage(repo, 'sub/.DS_Store', 'x');
    assertFails(scan(['--staged'], { cwd: repo }), 'local-state');
  });

  it('flags typechange and survives diff prefix config and odd names', () => {
    const repo = makeRepo();
    git(repo, ['config', 'diff.noprefix', 'true']);
    git(repo, ['config', 'diff.mnemonicPrefix', 'true']);
    stage(repo, 'we ird b/name.txt', `${BAD_EMAIL}\n`);
    stage(repo, 'qu"ote.txt', `\nfine\n/Users/${FAKE_NAME}/x\n`);
    const result = scan(['--staged'], { cwd: repo });
    assert.match(result.out, /^we ird b\/name\.txt:1 {2}email$/m);
    assert.match(result.out, /^qu"ote\.txt:3 {2}home-path$/m);
  });

  it('flags typechanged files (symlink to file)', () => {
    const repo = makeRepo();
    commitFile(repo, 'link', 'plain\n');
    rmSync(join(repo, 'link'));
    symlinkSync(`/Users/${FAKE_NAME}/x`, join(repo, 'link'));
    git(repo, ['add', 'link']);
    assertFails(scan(['--staged'], { cwd: repo }), 'home-path');
  });

  it('flags bare, lowercase and JSON-escaped home paths, but not URLs', () => {
    const bad = [
      `cd /Users/${FAKE_NAME}`,
      `"/Users/${FAKE_NAME}"`,
      `/users/${FAKE_NAME}/x`,
      `/HOME/${FAKE_NAME}/x`,
      `"C:\\\\Users\\\\${FAKE_NAME}\\\\x"`,
      `c:/users/${FAKE_NAME}`,
    ];
    for (const text of bad) assertFails(scan(['--stdin'], { input: text }), 'home-path');
    const good = ['https://api.invalid/users/someone', '/Users/Shared', '/home/runner'];
    for (const text of good) assert.equal(scan(['--stdin'], { input: text }).status, 0, text);
  });

  it('flags encoded emails', () => {
    for (const at of ['%40', '&#64;', '&#x40;', '&#X40;', '\\u0040', '\\x40', '&commat;']) {
      assertFails(scan(['--stdin'], { input: `someone${at}example.com` }), 'email');
    }
  });

  it('flags a .netrc password line', () => {
    assertFails(scan(['--stdin'], { input: '  password hunter2\n' }), 'credential');
  });

  it('exits 2 without leaking when the private patterns file is unreadable', () => {
    const repo = makeRepo();
    const file = join(repo, '.git', 'info', 'private-patterns');
    mkdirSync(file, { recursive: true }); // a directory: exists, cannot be read
    const result = scan(['--stdin'], { cwd: repo, input: 'x' });
    assert.equal(result.status, 2);
    assert.ok(!result.out.includes(repo));
  });

  it('--tag checks tagger email and message', () => {
    const repo = makeRepo();
    commitFile(repo, 'a.txt', 'one\n');
    git(repo, ['tag', '-a', 'v1', '-m', 'fine']);
    const good = git(repo, ['rev-parse', 'v1']);
    assert.equal(scan(['--tag', good], { cwd: repo }).status, 0);

    const env = { GIT_COMMITTER_EMAIL: BAD_EMAIL };
    git(repo, ['tag', '-a', 'v2', '-m', 'fine'], env);
    assertFails(scan(['--tag', git(repo, ['rev-parse', 'v2'])], { cwd: repo }), 'tagger-email');

    git(repo, ['tag', '-a', 'v3', '-m', `see ${BAD_EMAIL}`]);
    assertFails(scan(['--tag', git(repo, ['rev-parse', 'v3'])], { cwd: repo }), 'email');
  });

  it('pre-push blocks an annotated tag with a bad tagger email', () => {
    const repo = makeRepo();
    cpSync(join(REPO_ROOT, 'scripts', 'check-privacy.js'), join(repo, 'scripts', 'check-privacy.js'));
    cpSync(join(REPO_ROOT, '.githooks'), join(repo, '.githooks'), { recursive: true });
    git(repo, ['config', 'core.hooksPath', '.githooks']);
    const remote = mkdtempSync(join(tmpdir(), 'privacy-remote-'));
    roots.push(remote);
    git(remote, ['init', '-q', '--bare', '-b', 'main']);
    git(repo, ['remote', 'add', 'origin', remote]);
    commitFile(repo, 'a.txt', 'one\n');
    git(repo, ['push', '-q', 'origin', 'main']);
    git(repo, ['tag', '-a', 'bad', '-m', 'x'], { GIT_COMMITTER_EMAIL: BAD_EMAIL });
    assert.throws(() => git(repo, ['push', '-q', 'origin', 'bad']));
    git(repo, ['tag', '-a', 'good', '-m', 'x']);
    git(repo, ['push', '-q', 'origin', 'good']);
  });
});

describe('vendored-file exceptions', () => {
  const sha256 = (text) => createHash('sha256').update(text).digest('hex');
  const VENDOR = 'vendor/font.txt';

  /** A repo with a vendored file and an exceptions entry for it. */
  function makeExcepted(content, { hash = sha256(content), categories = ['email'] } = {}) {
    const repo = makeRepo();
    mkdirSync(join(repo, 'vendor'));
    mkdirSync(join(repo, 'scripts'));
    writeFileSync(join(repo, VENDOR), content);
    const entry = { path: VENDOR, sha256: hash, reason: 'upstream credits', categories };
    writeFileSync(join(repo, 'scripts', 'privacy-exceptions.json'), JSON.stringify([entry]));
    return repo;
  }

  it('ships empty', () => {
    const text = readFileSync(join(REPO_ROOT, 'scripts', 'privacy-exceptions.json'), 'utf8');
    assert.deepEqual(JSON.parse(text), []);
  });

  it('suppresses email for a file whose hash matches (--tree, --staged, --range)', () => {
    const content = `credits ${BAD_EMAIL}\n`;
    const repo = makeExcepted(content);
    assert.equal(scan(['--tree'], { cwd: repo }).status, 0);
    git(repo, ['add', '-A']);
    assert.equal(scan(['--staged'], { cwd: repo }).status, 0);
    git(repo, ['commit', '-q', '-m', 'add']);
    assert.equal(scan(['--range', `${'0'.repeat(40)}..HEAD`], { cwd: repo }).status, 0);
  });

  it('scans in full again when the hash differs', () => {
    const repo = makeExcepted(`credits ${BAD_EMAIL}\n`, { hash: sha256('something else') });
    assertFails(scan(['--tree'], { cwd: repo }), 'email');
    git(repo, ['add', '-A']);
    assertFails(scan(['--staged'], { cwd: repo }), 'email');
  });

  it('does not suppress after the file changes', () => {
    const repo = makeExcepted(`credits ${BAD_EMAIL}\n`);
    writeFileSync(join(repo, VENDOR), `credits ${BAD_EMAIL}\nmore\n`);
    assertFails(scan(['--tree'], { cwd: repo }), 'email');
  });

  it('suppresses only the listed categories', () => {
    const content = `credits ${BAD_EMAIL}\n/Users/${FAKE_NAME}/x\n`;
    const repo = makeExcepted(content);
    const result = scan(['--tree'], { cwd: repo });
    assertFails(result, 'home-path');
    assert.ok(!/\semail\n/.test(result.out));
  });

  it('never suppresses credentials, private patterns or local state', () => {
    const content = `credits ${BAD_EMAIL}\ntoken ${fakeToken('ghp_', 36)}\nfake-secret-term\n`;
    const repo = makeExcepted(content);
    writeFileSync(join(repo, '.git', 'info', 'private-patterns'), 'fake-secret-term\n');
    const result = scan(['--tree'], { cwd: repo });
    assertFails(result, 'credential');
    assertFails(result, 'private-pattern');
    assert.ok(!/\semail\n/.test(result.out));
  });

  it('rejects categories that may not be suppressed', () => {
    const repo = makeExcepted('x\n', { categories: ['credential'] });
    assert.equal(scan(['--tree'], { cwd: repo }).status, 2);
  });

  it('errors on a stale entry and on malformed files', () => {
    const repo = makeExcepted('x\n');
    rmSync(join(repo, VENDOR));
    const stale = scan(['--tree'], { cwd: repo });
    assert.equal(stale.status, 2);
    assert.match(stale.out, /stale/);
    writeFileSync(join(repo, 'scripts', 'privacy-exceptions.json'), '{not json');
    assert.equal(scan(['--tree'], { cwd: repo }).status, 2);
    writeFileSync(join(repo, 'scripts', 'privacy-exceptions.json'), '{}');
    assert.equal(scan(['--tree'], { cwd: repo }).status, 2);
  });

  it('scans the exceptions file itself', () => {
    const repo = makeExcepted('x\n');
    const entry = { path: VENDOR, sha256: sha256('x\n'), reason: `contact ${BAD_EMAIL}`, categories: ['email'] };
    writeFileSync(join(repo, 'scripts', 'privacy-exceptions.json'), JSON.stringify([entry]));
    assertFails(scan(['--tree'], { cwd: repo }), 'email');
  });
});
