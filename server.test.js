'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const SERVER_FILE = path.join(__dirname, 'server.js');
let testDirectory;
let root;
let port;
let child;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}

async function waitForServer() {
  let lastError;
  for (let i = 0; i < 40; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/state`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw lastError || new Error('server did not start');
}

before(async () => {
  testDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'local-workbench-test-'));
  root = path.join(testDirectory, 'root');
  await fs.mkdir(root);
  await fs.mkdir(path.join(root, 'folder'));
  await fs.writeFile(path.join(testDirectory, 'outside.txt'), 'outside');
  await fs.writeFile(path.join(root, '.hidden'), 'hidden');
  await fs.writeFile(path.join(root, 'visible.txt'), 'visible');
  await fs.symlink('visible.txt', path.join(root, 'visible-link'));
  port = await freePort();
  child = spawn(process.execPath, [SERVER_FILE, '--root', root, '--port', String(port)], { stdio: 'ignore' });
  await waitForServer();
});

after(async () => {
  child?.kill();
  await new Promise((resolve) => child?.once('close', resolve) || resolve());
  await fs.rm(testDirectory, { recursive: true, force: true });
});

test('state response includes the current user home directory', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/state`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).home, os.homedir());
});

test('list response excludes owner and permission metadata without following symlinks', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/list?path=.`);
  assert.equal(response.status, 200);
  const body = await response.json();
  const file = body.items.find((item) => item.name === 'visible.txt');
  const link = body.items.find((item) => item.name === 'visible-link');
  assert.equal('mode' in file, false);
  assert.equal('uid' in file, false);
  assert.equal('gid' in file, false);
  assert.equal(file.size, 7);
  assert.match(file.modifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(link.type, 'link');
  assert.equal('mode' in link, false);
  assert.equal(link.linkTarget, 'visible.txt');
});

test('file APIs can access paths outside the startup directory', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/file?path=../outside.txt`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    path: await fs.realpath(path.join(testDirectory, 'outside.txt')),
    content: 'outside',
  });
});

test('upload writes binary files, creates parent directories, and serves image previews', async () => {
  const content = Uint8Array.from([0, 1, 127, 128, 255]);
  const response = await fetch(`http://127.0.0.1:${port}/api/upload?path=uploads/nested/image.png`, {
    method: 'POST', body: content,
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    path: path.join(await fs.realpath(root), 'uploads', 'nested', 'image.png'),
    uploaded: true,
    size: content.length,
  });
  assert.deepEqual(await fs.readFile(path.join(root, 'uploads', 'nested', 'image.png')), Buffer.from(content));
  const preview = await fetch(`http://127.0.0.1:${port}/api/download?path=uploads/nested/image.png`);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), Buffer.from(content));
});

test('JSON formatter prettifies valid JSON and rejects invalid JSON', async () => {
  const html = await fs.readFile(path.join(__dirname, 'index.html'), 'utf8');
  const match = html.match(/  function formatJsonText\(text\) \{[\s\S]*?\n  \}/);
  assert.ok(match, 'formatJsonText function should exist');
  const formatJsonText = Function(`${match[0]}\nreturn formatJsonText;`)();
  assert.equal(formatJsonText('{"name":"workbench","items":[1,true]}'), '{\n  "name": "workbench",\n  "items": [\n    1,\n    true\n  ]\n}');
  assert.throws(() => formatJsonText('{invalid}'), SyntaxError);
});

test('text preview whitelist supports known dotfiles without accepting every dotfile', async () => {
  const html = await fs.readFile(path.join(__dirname, 'index.html'), 'utf8');
  const extensionsMatch = html.match(/  const TEXT_EXTENSIONS = new Set\((\[[\s\S]*?\])\);/);
  const filenamesMatch = html.match(/  const TEXT_FILENAMES = new Set\((\[[\s\S]*?\])\);/);
  const helpersMatch = html.match(/  function fileName\(filePath\) \{[\s\S]*?  function supportsTextPreview\(filePath\) \{[\s\S]*?\n  \}/);
  assert.ok(extensionsMatch, 'TEXT_EXTENSIONS should exist');
  assert.ok(filenamesMatch, 'TEXT_FILENAMES should exist');
  assert.ok(helpersMatch, 'text preview helper functions should exist');
  const textExtensions = Function(`return ${extensionsMatch[1]};`)();
  const textFilenames = Function(`return ${filenamesMatch[1]};`)();
  const supportsTextPreview = Function(`const TEXT_EXTENSIONS = new Set(${JSON.stringify(textExtensions)});
const TEXT_FILENAMES = new Set(${JSON.stringify(textFilenames)});
${helpersMatch[0]}
return supportsTextPreview;`)();
  assert.equal(supportsTextPreview('.zshrc'), true);
  assert.equal(supportsTextPreview('/home/test/.gitconfig'), true);
  assert.equal(supportsTextPreview('README.md'), true);
  assert.equal(supportsTextPreview('.DS_Store'), false);
});

test('unsupported files expose a read-only force preview action', async () => {
  const html = await fs.readFile(path.join(__dirname, 'index.html'), 'utf8');
  assert.match(html, /id="forcePreviewButton"[^>]*>强制预览（只读）<\/button>/);
  assert.match(html, /state\.selectedType = 'forced-text';/);
  assert.match(html, /editor\.readOnly = type !== 'text';/);
  assert.match(html, /saveButton\.disabled = type !== 'text';/);
  assert.match(html, /formatJsonButton\.hidden = type !== 'text'/);
});

test('terminal cd commands resolve directory targets for file-list synchronization', async () => {
  const html = await fs.readFile(path.join(__dirname, 'index.html'), 'utf8');
  const match = html.match(/  function cdTarget\(command, home, currentDirectory\) \{[\s\S]*?\n  \}\n\n  function syncPathLabels/);
  assert.ok(match, 'cdTarget function should exist');
  const cdTarget = Function(`${match[0].replace(/\n\n  function syncPathLabels$/, '')}\nreturn cdTarget;`)();
  assert.equal(cdTarget('cd', '/Users/test', '/work'), '/Users/test');
  assert.equal(cdTarget('cd ..', '/Users/test', '/work/project'), '/work/project/..');
  assert.equal(cdTarget('cd ~/projects', '/Users/test', '/work'), '/Users/test/projects');
  assert.equal(cdTarget('cd "/tmp/with space"', '/Users/test', '/work'), '/tmp/with space');
  assert.equal(cdTarget('pwd', '/Users/test', '/work'), null);
});

test('shell stream returns early output before command completes', async () => {
  const startedAt = Date.now();
  const response = await fetch(`http://127.0.0.1:${port}/api/shell/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'printf first; sleep 0.3; printf second', cwd: '.' }),
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = '';
  let firstAt = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
    if (firstAt === null && output.includes('first')) firstAt = Date.now();
  }
  output += decoder.decode();
  assert.ok(firstAt - startedAt < 250, `first output arrived after ${firstAt - startedAt}ms`);
  assert.equal(output, 'firstsecond');
});
