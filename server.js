#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { exec, spawn } = require('node:child_process');
const { URL } = require('node:url');

const HOST = process.env.HOST || '0.0.0.0';
const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_BYTES = 64 * 1024;
const SHELL_TIMEOUT_MS = 30_000;
const SHELL_MAX_BUFFER = 1024 * 1024;
const SHELL_MAX_OUTPUT_BYTES = 1024 * 1024;
const INDEX_FILE = path.join(__dirname, 'index.html');

function parseArgs(argv) {
  const options = { root: process.cwd(), port: DEFAULT_PORT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      options.root = argv[++i];
    } else if (arg === '--port') {
      options.port = Number(argv[++i]);
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node server.js [--root <directory>] [--port <port>]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error('--port must be an integer between 1 and 65535');
  }
  return options;
}

function resolvePath(relativePath, root) {
  return path.resolve(root, relativePath || '.');
}

async function existingPath(relativePath, root) {
  return fs.realpath(resolvePath(relativePath, root));
}

async function writablePath(relativePath, root) {
  const candidate = resolvePath(relativePath, root);
  try {
    return await fs.realpath(candidate);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const parent = await fs.realpath(path.dirname(candidate));
  return path.join(parent, path.basename(candidate));
}

async function uploadPath(relativePath, root) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    const error = new Error('path is required');
    error.statusCode = 400;
    throw error;
  }
  const candidate = resolvePath(relativePath, root);
  await fs.mkdir(path.dirname(candidate), { recursive: true });
  return candidate;
}

function contentType(file) {
  switch (path.extname(file).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.svg': return 'image/svg+xml';
    case '.bmp': return 'image/bmp';
    case '.avif': return 'image/avif';
    default: return 'application/octet-stream';
  }
}

async function downloadFile(response, relative, root) {
  const file = await existingPath(relative, root);
  const stat = await fs.stat(file);
  if (!stat.isFile()) {
    const error = new Error('Path is not a regular file');
    error.statusCode = 400;
    throw error;
  }
  response.writeHead(200, {
    'Content-Type': contentType(file),
    'Content-Length': stat.size,
    'Content-Disposition': 'inline',
    'Cache-Control': 'no-store',
  });
  createReadStream(file).on('error', () => response.destroy()).pipe(response);
  return true;
}

function relativePath(absolutePath) {
  return absolutePath;
}

function json(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function text(response, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(statusCode, { 'Content-Type': contentType });
  response.end(body);
}

async function readBody(request, maxBytes = MAX_BODY_BYTES) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error(`Request body exceeds ${maxBytes} bytes`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  const body = await readBody(request);
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    const error = new Error('Invalid JSON request body');
    error.statusCode = 400;
    throw error;
  }
}

function shellName() {
  return process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
}

function shellCommand(command, cwd) {
  return new Promise((resolve) => {
    exec(command, {
      cwd,
      shell: shellName(),
      timeout: SHELL_TIMEOUT_MS,
      maxBuffer: SHELL_MAX_BUFFER,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error && typeof error.code === 'number' ? error.code : 0,
        signal: error && error.signal ? error.signal : null,
        stdout,
        stderr: stderr || (error && error.message ? error.message : ''),
      });
    });
  });
}

function fileType(stat) {
  if (stat.isDirectory()) return 'directory';
  if (stat.isSymbolicLink()) return 'link';
  return 'file';
}

async function listDirectory(relative, root) {
  const directory = await existingPath(relative, root);
  const stat = await fs.stat(directory);
  if (!stat.isDirectory()) {
    const error = new Error('Path is not a directory');
    error.statusCode = 400;
    throw error;
  }
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const items = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    const entryStat = await fs.lstat(absolute);
    const item = {
      name: entry.name,
      path: relativePath(absolute),
      type: fileType(entryStat),
      size: entryStat.size,
      modifiedAt: entryStat.mtime.toISOString(),
    };
    if (entryStat.isSymbolicLink()) {
      item.linkTarget = await fs.readlink(absolute).catch(() => '?');
    }
    return item;
  }));
  items.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  return { path: relativePath(directory), items };
}

async function deletablePath(relativePath, root) {
  const candidate = resolvePath(relativePath, root);
  const stat = await fs.lstat(candidate);
  if (!stat.isSymbolicLink()) {
    return { path: await existingPath(relativePath, root), isLink: false };
  }
  return { path: candidate, isLink: true };
}

async function readTextFile(relative, root) {
  const file = await existingPath(relative, root);
  const stat = await fs.stat(file);
  if (!stat.isFile()) {
    const error = new Error('Path is not a regular file');
    error.statusCode = 400;
    throw error;
  }
  if (stat.size > MAX_FILE_BYTES) {
    const error = new Error(`File is larger than ${MAX_FILE_BYTES} bytes`);
    error.statusCode = 413;
    throw error;
  }
  return { path: relativePath(file), content: await fs.readFile(file, 'utf8') };
}

async function shellInput(body, root) {
  if (typeof body.command !== 'string' || !body.command.trim()) {
    const error = new Error('command is required');
    error.statusCode = 400;
    throw error;
  }
  if (Buffer.byteLength(body.command, 'utf8') > MAX_COMMAND_BYTES) {
    const error = new Error(`command exceeds ${MAX_COMMAND_BYTES} bytes`);
    error.statusCode = 413;
    throw error;
  }
  const cwd = await existingPath(typeof body.cwd === 'string' ? body.cwd : '.', root);
  const stat = await fs.stat(cwd);
  if (!stat.isDirectory()) {
    const error = new Error('cwd must be a directory');
    error.statusCode = 400;
    throw error;
  }
  return { command: body.command, cwd };
}

function streamShell(response, command, cwd) {
  // ponytail: one process per command; use a PTY when persistent shells or interactive programs are required.
  return new Promise((resolve) => {
    let child;
    let finished = false;
    let outputBytes = 0;
    let outputLimited = false;
    let timeout = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (timeout) clearTimeout(timeout);
      if (!response.writableEnded && !response.destroyed) response.end();
      resolve(true);
    };
    const stop = (signal = 'SIGTERM') => {
      if (child && child.exitCode === null && !child.killed) child.kill(signal);
    };
    const write = (chunk) => {
      if (finished || response.destroyed || outputLimited) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = SHELL_MAX_OUTPUT_BYTES - outputBytes;
      if (remaining <= 0) return;
      response.write(buffer.subarray(0, remaining));
      outputBytes += Math.min(buffer.length, remaining);
      if (buffer.length >= remaining) {
        outputLimited = true;
        stop();
      }
    };

    response.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    });
    try {
      child = spawn(command, { cwd, shell: shellName(), windowsHide: true });
    } catch (error) {
      write(`Unable to start shell: ${error.message}\n`);
      return finish();
    }
    timeout = setTimeout(() => {
      stop();
    }, SHELL_TIMEOUT_MS);

    child.stdout.on('data', write);
    child.stderr.on('data', write);
    child.on('error', (error) => {
      write(`Unable to start shell: ${error.message}\n`);
    });
    child.on('close', finish);
    response.on('close', () => {
      if (!finished) stop();
    });
  });
}

async function handleApi(request, response, url, root) {
  if (request.method === 'GET' && url.pathname === '/api/state') {
    return json(response, 200, { root, home: os.homedir(), platform: process.platform });
  }

  if (request.method === 'GET' && url.pathname === '/api/list') {
    return json(response, 200, await listDirectory(url.searchParams.get('path') || '.', root));
  }

  if (request.method === 'GET' && url.pathname === '/api/file') {
    return json(response, 200, await readTextFile(url.searchParams.get('path') || '.', root));
  }

  if (request.method === 'GET' && url.pathname === '/api/download') {
    return downloadFile(response, url.searchParams.get('path') || '.', root);
  }

  if (request.method !== 'POST') return false;

  if (url.pathname === '/api/upload') {
    const file = await uploadPath(url.searchParams.get('path'), root);
    const content = await readBody(request, MAX_UPLOAD_BYTES);
    await fs.writeFile(file, content);
    return json(response, 201, { path: relativePath(file), uploaded: true, size: content.length });
  }

  const body = await readJson(request);

  if (url.pathname === '/api/file') {
    if (typeof body.path !== 'string' || typeof body.content !== 'string') {
      const error = new Error('path and content are required');
      error.statusCode = 400;
      throw error;
    }
    const file = await writablePath(body.path, root);
    await fs.writeFile(file, body.content, 'utf8');
    return json(response, 200, { path: relativePath(file), saved: true });
  }

  if (url.pathname === '/api/mkdir') {
    if (typeof body.path !== 'string' || !body.path.trim()) {
      const error = new Error('path is required');
      error.statusCode = 400;
      throw error;
    }
    const directory = await writablePath(body.path, root);
    await fs.mkdir(directory, { recursive: false });
    return json(response, 201, { path: relativePath(directory), created: true });
  }

  if (url.pathname === '/api/delete') {
    if (typeof body.path !== 'string' || !body.path.trim() || body.path === '.') {
      const error = new Error('A non-root path is required');
      error.statusCode = 400;
      throw error;
    }
    const target = await deletablePath(body.path, root);
    if (target.isLink) {
      await fs.unlink(target.path);
    } else {
      await fs.rm(target.path, { recursive: true, force: false });
    }
    return json(response, 200, { path: relativePath(target.path), deleted: true });
  }

  if (url.pathname === '/api/shell' || url.pathname === '/api/shell/stream') {
    const input = await shellInput(body, root);
    if (url.pathname === '/api/shell/stream') {
      return streamShell(response, input.command, input.cwd);
    }
    return json(response, 200, {
      cwd: relativePath(input.cwd),
      ...(await shellCommand(input.command, input.cwd)),
    });
  }

  return false;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = await fs.realpath(path.resolve(options.root));
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${HOST}`);
      if (url.pathname.startsWith('/api/')) {
        const handled = await handleApi(request, response, url, root);
        if (!handled && !response.headersSent) json(response, 404, { error: 'API route not found' });
        return;
      }
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return text(response, 200, await fs.readFile(INDEX_FILE), 'text/html; charset=utf-8');
      }
      text(response, 404, 'Not found');
    } catch (error) {
      const statusCode = error.statusCode || (error.code === 'ENOENT' ? 404 : 500);
      if (!response.headersSent) json(response, statusCode, { error: error.message || 'Internal server error' });
      else response.destroy();
    }
  });

  server.listen(options.port, HOST, () => {
    console.log(`Local workbench: http://${HOST}:${options.port}`);
    console.log(`Initial directory: ${root}`);
    console.log('Shell commands run with the current user permissions.');
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
