// 核验最终可执行文件经 HTTP 提供的全部内嵌资源与当前 public/ 完全一致。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const exe = path.join(root, 'forzalan.exe');
const reportPath = path.join(root, 'tools', 'embedded-assets-report.json');
const digest = (data) => createHash('sha256').update(data).digest('hex');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function filesIn(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(dir, entry.name);
    return entry.isDirectory() ? filesIn(name) : entry.isFile() ? [name] : [];
  });
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((err) => err ? reject(err) : resolve()));
  return port;
}

const files = filesIn(publicDir).sort();
assert(files.length > 0, 'public/ 必须包含实际文件');
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const testDir = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'forzalan-assets-'));
const server = spawn(exe, ['-addr', `127.0.0.1:${port}`, '-quiet'], {
  cwd: testDir, stdio: ['ignore', 'pipe', 'pipe'],
});
let spawnError;
let serverOutput = '';
server.on('error', (err) => { spawnError = err; });
server.stdout.on('data', (data) => { serverOutput = (serverOutput + data.toString()).slice(-65536); });
server.stderr.on('data', (data) => { serverOutput = (serverOutput + data.toString()).slice(-65536); });
const stopped = new Promise((resolve) => server.once('close', resolve));
const results = [];
let failure;

try {
  let ready = false;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (server.exitCode !== null) throw new Error(`服务提前退出 ${server.exitCode}: ${serverOutput}`);
    try {
      const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
      ready = response.ok;
      await response.arrayBuffer();
      if (ready) break;
    } catch { /* 启动期间暂未监听，重试健康检查。 */ }
    await delay(100);
  }
  assert(ready, `服务未就绪: ${serverOutput}`);

  for (const file of files) {
    const relative = path.relative(publicDir, file).split(path.sep).join('/');
    const urlPath = relative.split('/').map(encodeURIComponent).join('/');
    const response = await fetch(`${base}/${urlPath}`, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200, `${relative} HTTP 状态`);
    const served = Buffer.from(await response.arrayBuffer());
    const source = readFileSync(file);
    const sha256 = digest(source);
    assert.equal(served.length, source.length, `${relative} 字节数`);
    assert.equal(digest(served), sha256, `${relative} 内嵌内容过时`);
    results.push({ path: relative, bytes: source.length, sha256 });
  }
  assert.equal(new Set(results.map((entry) => entry.path)).size, files.length, '全量资源无重复或遗漏');
  assert.equal(results.length, files.length, '全部 public/ 文件均经过 HTTP 比对');
} catch (err) {
  failure = err;
} finally {
  if (server.exitCode === null) server.kill();
  let timer;
  try {
    await Promise.race([
      stopped,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('测试服务未退出')), 5000); }),
    ]);
  } catch (err) {
    failure ||= err;
  } finally {
    clearTimeout(timer);
  }
  rmSync(testDir, { recursive: true, force: true });
}

writeFileSync(reportPath, JSON.stringify({
  checkedAt: new Date().toISOString(), executable: 'forzalan.exe',
  executableSha256: digest(readFileSync(exe)), expectedFiles: files.length,
  checkedFiles: results.length, passed: !failure, results,
  error: failure ? String(failure) : null,
}, null, 2) + '\n');
if (failure) throw failure;
console.log(`PASS 全部 ${results.length}/${files.length} 个 public/ 资源：HTTP 字节数与 SHA-256 均一致`);
console.log('PASS 临时服务已退出，积分数据目录已清理');
console.log(`报告: ${reportPath}`);
