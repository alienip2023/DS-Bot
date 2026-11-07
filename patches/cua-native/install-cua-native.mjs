#!/usr/bin/env node
/**
 * Install a compiled dsh-cua-native into the live DSH profile.
 *
 * The copy inside app.asar ships Swift sources and an empty native/bin.
 * prepareNativeExecutable only compiles in a @deepseek-ai/dsh-root checkout,
 * so an installed package fails access() and Computer Use stays missing.
 * This script extracts the package, builds the helper, and places the whole
 * package in the profile node_modules so resolution hits the copy first.
 *
 * It never writes app.asar and refuses to install into a ds-bot plugin directory.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir, arch as osArch, platform as osPlatform } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  accessSync,
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-cua-macos';
const ASAR_PARTS = ['node_modules', '@deepseek-ai', 'dsh-experimental-cua-macos'];
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const PRODUCT = 'dsh-cua-native';

if (process.env.ELECTRON_NO_ASAR !== '1') {
  const child = spawnSync(process.execPath, process.argv.slice(1), {
    env: { ...process.env, ELECTRON_NO_ASAR: '1' },
    stdio: 'inherit',
  });
  process.exit(child.status ?? 1);
}

function fail(message) {
  const error = new Error(message);
  error.handled = true;
  throw error;
}

function parseArgs(argv) {
  const out = { dryRun: false, profile: process.env.DSH_PROFILE || '', dshHome: process.env.DSH_HOME || '', app: process.env.DSH_APP_ASAR || '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) fail(`缺少参数值：${arg}`);
      i += 1;
      return value;
    };
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--profile') out.profile = next();
    else if (arg.startsWith('--profile=')) out.profile = arg.slice('--profile='.length);
    else if (arg === '--dsh-home') out.dshHome = next();
    else if (arg.startsWith('--dsh-home=')) out.dshHome = arg.slice('--dsh-home='.length);
    else if (arg === '--app') out.app = next();
    else if (arg.startsWith('--app=')) out.app = arg.slice('--app='.length);
    else fail(`未知参数：${arg}`);
  }
  return out;
}

function printHelp() {
  process.stdout.write(`用法：node patches/cua-native/install-cua-native.mjs [--dry-run] [--profile <名称或路径>] [--dsh-home <路径>] [--app <app.asar>]

从 /Applications/DSH Desktop.app 的 app.asar 提取 ${PACKAGE_NAME}，编译 native/bin 里缺失的 ${PRODUCT}，装到当前 profile 的 node_modules。已存在且 sha256 一致则跳过编译。
`);
}

function defaultDshHome() {
  return join(homedir(), 'Library', 'Application Support', 'dsh-desktop', 'harness');
}

function defaultAppAsar() {
  return join('/Applications/DSH Desktop.app', 'Contents', 'Resources', 'app.asar');
}

function listProfiles(dshHome) {
  const root = join(dshHome, 'profiles');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(root, name, 'cordis.yml')));
}

function detectLiveProfile(dshHome) {
  const profiles = listProfiles(dshHome);
  if (profiles.length === 0) fail(`没有找到带 cordis.yml 的 profile：${join(dshHome, 'profiles')}。请传 --profile。`);
  let commands = '';
  try {
    commands = spawnSync('ps', ['-ax', '-o', 'command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).stdout || '';
  } catch {
    commands = '';
  }
  const hits = [];
  for (const name of profiles) {
    const needle = `${join(dshHome, 'profiles', name)}${sep}`;
    if (commands.includes(needle)) hits.push(name);
  }
  const preferred = hits.filter((name) => name !== 'desktop-safe-mode');
  if (preferred.length > 0) return { name: preferred[0], source: 'process' };
  if (hits.length > 0) return { name: hits[0], source: 'process' };
  const normal = profiles.filter((name) => name !== 'desktop-safe-mode');
  if (normal.length === 1) return { name: normal[0], source: 'only-profile' };
  if (profiles.length === 1) return { name: profiles[0], source: 'only-profile' };
  fail(`无法判断当前 live profile（${profiles.join(', ')}）。请传 --profile。`);
}

function resolveProfile(dshHome, profileArg) {
  if (profileArg) {
    const dir = isAbsolute(profileArg) ? profileArg : join(dshHome, 'profiles', profileArg);
    if (!existsSync(join(dir, 'cordis.yml'))) fail(`profile 没有 cordis.yml：${dir}`);
    return { dir: realpathSync(dir), source: 'arg' };
  }
  const detected = detectLiveProfile(dshHome);
  return { dir: realpathSync(join(dshHome, 'profiles', detected.name)), source: detected.source };
}

function assertSafePackageDir(packageDir) {
  const parts = packageDir.split(sep);
  if (parts.some((part) => part === 'ds-bot' || part.startsWith('ds-bot+'))) {
    fail('拒绝：不能把 @deepseek-ai 装进 ds-bot 插件目录。');
  }
  if (packageDir.includes(`${sep}app.asar`) || packageDir.endsWith(`${sep}app.asar`)) {
    fail('拒绝：不能写 app.asar。');
  }
  const suffix = `${sep}node_modules${sep}@deepseek-ai${sep}dsh-experimental-cua-macos`;
  if (!packageDir.endsWith(suffix)) fail(`拒绝写入非预期目录：${packageDir}`);
}

function openAsar(asarPath) {
  if (!existsSync(asarPath)) fail(`找不到 app.asar：${asarPath}`);
  const fd = openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    const headGot = readSync(fd, head, 0, 16, 0);
    if (headGot !== 16) fail('app.asar 头部不足 16 字节');
    const headerSize = head.readUInt32LE(4);
    const jsonSize = head.readUInt32LE(12);
    const json = Buffer.alloc(jsonSize);
    let got = 0;
    while (got < jsonSize) {
      const n = readSync(fd, json, got, jsonSize - got, 16 + got);
      if (n === 0) fail('app.asar 头 JSON 读取提前结束');
      got += n;
    }
    const tree = JSON.parse(json.toString('utf8'));
    return { fd, tree, base: 8 + headerSize, asarPath };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function findNode(tree, parts) {
  let cur = tree;
  for (const part of parts) {
    if (!cur.files || !cur.files[part]) return null;
    cur = cur.files[part];
  }
  return cur;
}

function safeChild(root, name) {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    fail(`asar 条目名不安全：${name}`);
  }
  const dest = join(root, name);
  if (dest !== root && !dest.startsWith(`${root}${sep}`)) fail(`路径逃出目标：${dest}`);
  return dest;
}

function readExact(fd, offset, size) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size)) {
    fail(`asar 偏移超出安全整数：${offset}+${size}`);
  }
  const buf = Buffer.alloc(size);
  let got = 0;
  while (got < size) {
    const n = readSync(fd, buf, got, size - got, offset + got);
    if (n === 0) fail(`asar 读取提前结束：需要 ${size}，得到 ${got}`);
    got += n;
  }
  return buf;
}

function extractNode(asar, node, dest, relPath, stats) {
  mkdirSync(dest, { recursive: true });
  if (!node.files) {
    fail(`asar 包节点不是目录：${relPath}`);
  }
  for (const [name, child] of Object.entries(node.files)) {
    const childDest = safeChild(dest, name);
    const childRel = relPath ? `${relPath}/${name}` : name;
    if (child.files) {
      extractNode(asar, child, childDest, childRel, stats);
      continue;
    }
    if (typeof child.link === 'string') {
      if (isAbsolute(child.link)) fail(`拒绝 asar 绝对链接：${childRel}`);
      symlinkSync(child.link, childDest);
      stats.files += 1;
      continue;
    }
    const mode = child.executable ? 0o755 : 0o644;
    if (child.unpacked) {
      const unpacked = join(`${asar.asarPath}.unpacked`, ...ASAR_PARTS, ...childRel.split('/'));
      if (!existsSync(unpacked)) fail(`asar unpacked 文件缺失：${unpacked}`);
      copyFileSync(unpacked, childDest);
      stats.files += 1;
      continue;
    }
    const size = Number(child.size || 0);
    if (size === 0) {
      writeFileSync(childDest, Buffer.alloc(0), { mode });
      stats.files += 1;
      continue;
    }
    const offset = asar.base + Number(child.offset);
    writeFileSync(childDest, readExact(asar.fd, offset, size), { mode });
    stats.files += 1;
    stats.bytes += size;
  }
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function collectFiles(root, predicate) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs);
      if (!predicate(rel)) continue;
      if (entry.isDirectory()) walk(abs);
      else files.push({ rel, abs, link: entry.isSymbolicLink() });
    }
  };
  if (existsSync(root)) walk(root);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return files;
}

function fingerprint(root, predicate) {
  const hash = createHash('sha256');
  for (const file of collectFiles(root, predicate)) {
    hash.update(file.rel);
    hash.update('\0');
    hash.update(file.link ? readlinkSync(file.abs) : readFileSync(file.abs));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function isBuildOrBin(rel) {
  return rel === join('native', '.build')
    || rel.startsWith(`${join('native', '.build')}${sep}`)
    || rel === join('native', 'bin')
    || rel.startsWith(`${join('native', 'bin')}${sep}`);
}

function nativeFingerprint(root) {
  return fingerprint(root, (rel) => rel === 'native' || rel.startsWith(`native${sep}`) ? !isBuildOrBin(rel) : false);
}

function packageFingerprint(root) {
  return fingerprint(root, (rel) => rel !== '.cua-native-install.json' && !isBuildOrBin(rel));
}

function hostArch() {
  if (osPlatform() !== 'darwin') fail('只支持 macOS。');
  const arch = osArch();
  if (arch !== 'arm64' && arch !== 'x64') fail(`不支持的架构：${arch}`);
  return { arch, swiftArch: arch === 'x64' ? 'x86_64' : 'arm64' };
}

function assertMachO(file) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4);
    if (readSync(fd, buf, 0, 4, 0) !== 4) fail('编译产物过短');
    const magic = buf.readUInt32LE(0);
    const ok = magic === 0xfeedfacf || magic === 0xcffaedfe || magic === 0xfeedface || magic === 0xcefaedfe;
    if (!ok) fail(`产物不是 Mach-O，magic=0x${magic.toString(16)}`);
  } finally {
    closeSync(fd);
  }
}

function findProduct(buildRoot) {
  const hits = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'dSYM') continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && entry.name === PRODUCT) hits.push(abs);
    }
  };
  walk(buildRoot);
  hits.sort((a, b) => {
    const score = (file) => (/[/\\]Release[/\\]|[/\\]release[/\\]/.test(file) ? 0 : 1);
    return score(a) - score(b) || a.length - b.length;
  });
  return hits[0] || '';
}

function runSwift(packageRoot, swiftArch) {
  const nativeRoot = join(packageRoot, 'native');
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/xcrun', [
      'swift', 'build',
      '--package-path', nativeRoot,
      '--configuration', 'release',
      '--product', PRODUCT,
      '--arch', swiftArch,
    ], {
      cwd: packageRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_NO_ASAR: '1' },
    });
    let stderr = '';
    const keep = (chunk) => {
      const text = chunk.toString('utf8');
      stderr = (stderr + text).slice(-4000);
      process.stderr.write(text);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('swift build 超时。回滚：若已写入 profile 副本，删除该目录。'));
    }, BUILD_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && signal === null) resolve();
      else reject(new Error(`swift build 失败 (${String(code)}, ${String(signal)})：${stderr.slice(-800)}`));
    });
  });
}

function readStamp(packageDir) {
  const stampPath = join(packageDir, '.cua-native-install.json');
  if (!existsSync(stampPath)) return null;
  try {
    return JSON.parse(readFileSync(stampPath, 'utf8'));
  } catch {
    return null;
  }
}

function binaryPath(packageDir, arch) {
  return join(packageDir, 'native', 'bin', `darwin-${arch}`, PRODUCT);
}

function cachePaths(dshHome, nativeHash) {
  const dir = join(dshHome, '.cache', 'cua-native', nativeHash);
  return { dir, binary: join(dir, PRODUCT), sha: join(dir, 'sha256') };
}

function verify(profileDir, packageDir, binary) {
  const anchor = join(profileDir, 'cordis.yml');
  if (!existsSync(anchor)) fail(`缺少解析锚点：${anchor}`);
  const resolved = createRequire(anchor).resolve(PACKAGE_NAME);
  const resolvedReal = realpathSync(resolved);
  const packageReal = realpathSync(packageDir);
  if (resolvedReal !== packageReal && !resolvedReal.startsWith(`${packageReal}${sep}`)) {
    fail(`解析没有命中副本：${resolved}`);
  }
  if (resolvedReal.includes(`${sep}app.asar${sep}`) || resolvedReal.includes(`${sep}app.asar.unpacked${sep}`)) {
    fail(`解析仍落在 app.asar：${resolved}`);
  }
  accessSync(binary, constants.X_OK);
  return resolvedReal;
}

function copyPackage(stage, dest) {
  mkdirSync(dest, { recursive: true });
  cpSync(stage, dest, {
    recursive: true,
    dereference: false,
    filter: (source) => {
      const rel = relative(stage, source);
      return !rel || !isBuildOrBin(rel);
    },
  });
}

function placeBinary(packageDir, built, arch) {
  const dest = binaryPath(packageDir, arch);
  mkdirSync(join(packageDir, 'native', 'bin', `darwin-${arch}`), { recursive: true });
  copyFileSync(built, dest);
  writeFileSync(dest, readFileSync(built), { mode: 0o755 });
  assertMachO(dest);
  accessSync(dest, constants.X_OK);
  return dest;
}

function rollback(state) {
  if (!state || state.rolled) return;
  state.rolled = true;
  if (state.tmp && existsSync(state.tmp)) rmSync(state.tmp, { recursive: true, force: true });
  if (!state.packageDir) return;
  if (state.replaced && state.bak && existsSync(state.bak)) {
    rmSync(state.packageDir, { recursive: true, force: true });
    renameSync(state.bak, state.packageDir);
    process.stderr.write(`已回滚：恢复 ${state.packageDir}\n`);
    return;
  }
  if (state.created && existsSync(state.packageDir)) {
    rmSync(state.packageDir, { recursive: true, force: true });
    process.stderr.write(`已回滚：删除 ${state.packageDir}\n`);
  }
  if (state.created || state.replaced) {
    process.stderr.write(`回滚提示：删除 ${state.packageDir}\n`);
  }
}

function report(fields) {
  for (const [key, value] of Object.entries(fields)) {
    process.stdout.write(`${key}: ${value}\n`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const dshHome = realpathSync(args.dshHome || defaultDshHome());
  const appAsar = args.app || defaultAppAsar();
  const profile = resolveProfile(dshHome, args.profile);
  const packageDir = join(profile.dir, 'node_modules', '@deepseek-ai', 'dsh-experimental-cua-macos');
  assertSafePackageDir(packageDir);
  const { arch, swiftArch } = hostArch();
  const asar = openAsar(appAsar);
  const state = { packageDir, created: false, replaced: false, bak: '', tmp: '', rolled: false };
  const stage = join(osTmp(), `cua-native-stage-${process.pid}`);
  try {
    const node = findNode(asar.tree, ASAR_PARTS);
    if (!node) fail(`app.asar 里没有 ${PACKAGE_NAME}`);
    rmSync(stage, { recursive: true, force: true });
    const stats = { files: 0, bytes: 0 };
    extractNode(asar, node, stage, '', stats);
    if (stats.files === 0) fail('提取结果是空包');
    const manifest = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8'));
    if (manifest.name !== PACKAGE_NAME) fail(`提取到的包名不对：${manifest.name}`);
    const nativeHash = nativeFingerprint(stage);
    const packageHash = packageFingerprint(stage);
    const installedBinary = binaryPath(packageDir, arch);
    const stamp = existsSync(packageDir) ? readStamp(packageDir) : null;
    const installedHash = existsSync(installedBinary) ? sha256File(installedBinary) : '';
    const sameBinary = Boolean(stamp && installedHash && stamp.binarySha256 === installedHash && stamp.nativeFingerprint === nativeHash);
    if (args.dryRun) {
      report({
        action: sameBinary && stamp.packageFingerprint === packageHash ? 'skip' : 'dry-run',
        reason: sameBinary ? 'binary sha256 matches, not rebuilding' : 'would extract, build, install',
        compile: sameBinary ? 'skipped' : 'would-run',
        profile: profile.dir,
        profile_source: profile.source,
        package: packageDir,
        binary: installedBinary,
        sha256: installedHash || 'absent',
        extracted: stats.files,
        asar_base: asar.base,
        version: manifest.version,
      });
      return;
    }
    if (sameBinary && stamp.packageFingerprint === packageHash) {
      const resolved = verify(profile.dir, packageDir, installedBinary);
      report({
        action: 'skip',
        reason: 'binary sha256 matches, not rebuilding',
        compile: 'skipped',
        profile: profile.dir,
        profile_source: profile.source,
        package: packageDir,
        binary: installedBinary,
        sha256: installedHash,
        resolved,
        x_ok: 'pass',
        extracted: stats.files,
        asar_base: asar.base,
        version: manifest.version,
      });
      return;
    }
    const cache = cachePaths(dshHome, nativeHash);
    let built = '';
    let compile = 'ran';
    if (existsSync(cache.binary) && existsSync(cache.sha)) {
      const cached = readFileSync(cache.sha, 'utf8').trim();
      if (cached === sha256File(cache.binary)) {
        built = cache.binary;
        compile = 'reused-cache';
      }
    }
    if (!built) {
      await runSwift(stage, swiftArch);
      built = findProduct(join(stage, 'native', '.build'));
      if (!built) fail('swift build 结束，但没有找到 dsh-cua-native。回滚：删除 profile 里的副本目录。');
      assertMachO(built);
      mkdirSync(cache.dir, { recursive: true });
      copyFileSync(built, cache.binary);
      writeFileSync(cache.binary, readFileSync(built), { mode: 0o755 });
      writeFileSync(cache.sha, sha256File(cache.binary));
    }
    const tmp = `${packageDir}.tmp-${process.pid}`;
    state.tmp = tmp;
    rmSync(tmp, { recursive: true, force: true });
    copyPackage(stage, tmp);
    const placed = placeBinary(tmp, built, arch);
    const hash = sha256File(placed);
    if (existsSync(packageDir)) {
      state.bak = `${packageDir}.bak-${process.pid}`;
      rmSync(state.bak, { recursive: true, force: true });
      renameSync(packageDir, state.bak);
      state.replaced = true;
    } else {
      state.created = true;
    }
    mkdirSync(join(profile.dir, 'node_modules', '@deepseek-ai'), { recursive: true });
    renameSync(tmp, packageDir);
    const resolved = verify(profile.dir, packageDir, binaryPath(packageDir, arch));
    writeFileSync(join(packageDir, '.cua-native-install.json'), `${JSON.stringify({
      binarySha256: hash,
      nativeFingerprint: nativeHash,
      packageFingerprint: packageHash,
      version: manifest.version,
    }, null, 2)}\n`);
    if (state.bak && existsSync(state.bak)) rmSync(state.bak, { recursive: true, force: true });
    state.created = false;
    state.replaced = false;
    report({
      action: compile === 'ran' ? 'built' : 'reused-cache',
      compile,
      profile: profile.dir,
      profile_source: profile.source,
      package: packageDir,
      binary: binaryPath(packageDir, arch),
      sha256: hash,
      resolved,
      x_ok: 'pass',
      extracted: stats.files,
      asar_base: asar.base,
      version: manifest.version,
    });
  } catch (error) {
    rollback(state);
    throw error;
  } finally {
    closeSync(asar.fd);
    rmSync(stage, { recursive: true, force: true });
  }
}

function osTmp() {
  return process.env.TMPDIR || '/tmp';
}

main().catch((error) => {
  process.stderr.write(`失败：${error.message}\n`);
  if (!/回滚|拒绝/.test(error.message)) {
    process.stderr.write('回滚提示：删除 profile 下 node_modules/@deepseek-ai/dsh-experimental-cua-macos。不要改 app.asar。\n');
  }
  process.exit(1);
});
