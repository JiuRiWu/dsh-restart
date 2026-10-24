// 最小 asar 读写库（零依赖）。仅供 dsh-restart 外壳补丁使用。
// 已针对本机 app.asar 实测校验：roundtrip 输出与原文件逐字节相同。
import fs from 'node:fs';
import crypto from 'node:crypto';

const BLOCK = 4194304;
const CHUNK = 4194304;

/** 解析 asar 头部（三段 pickle 布局：16 字节前缀 + JSON + 对齐填充）。 */
export function readArchiveHeader(fd) {
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const pickle1 = head.readUInt32LE(0);
  const headerSize = head.readUInt32LE(4);
  const pickle2 = head.readUInt32LE(8);
  const strLen = head.readUInt32LE(12);
  // V8 的 Pickle.WriteString 会把字符串补齐到 4 字节边界，所以 pickle 里记的长度
  // 是**补齐后**的：JSON 长度是 4 的倍数时二者相等，否则差 1~3 字节。
  // 0.2.1-rc.3 这一版的 JSON 长度是奇数，正是靠这个补齐才发现必须按对齐算。
  const padded = strLen + ((4 - (strLen % 4)) % 4);
  if (pickle1 !== 4) throw new Error(`asar 头部前缀异常：pickle1=${pickle1}（应为 4）`);
  if (pickle2 !== padded + 4) throw new Error(`asar 头部 pickle 框架不匹配：u32@8=${pickle2}，JSON 补齐后+4=${padded + 4}（JSON ${strLen} 字节）`);
  if (headerSize !== padded + 8) throw new Error(`asar 头部长度不自洽：u32@4=${headerSize}，JSON 补齐后+8=${padded + 8}（JSON ${strLen} 字节）`);
  const jbuf = Buffer.alloc(strLen);
  fs.readSync(fd, jbuf, 0, strLen, 16);
  return {
    headerSize,
    strLen,
    json: jbuf.toString('utf8'),
    header: JSON.parse(jbuf.toString('utf8')),
    dataStart: 8 + headerSize,
  };
}

/** 深度遍历所有叶子条目，返回 { path, entry }（path 以 / 开头）。 */
export function collectFiles(header) {
  const out = [];
  const walk = (node, prefix) => {
    for (const [k, v] of Object.entries(node.files ?? {})) {
      const p = `${prefix}/${k}`;
      if (v.files) walk(v, p);
      else out.push({ path: p, entry: v });
    }
  };
  walk(header, '');
  return out;
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 单块文件的 integrity 重算；超大文件拒绝处理（本补丁用不到）。 */
export function integrityOf(buf, template) {
  const blockSize = template?.blockSize ?? BLOCK;
  if (buf.length > blockSize) throw new Error(`integrity：不支持超过一个块的文件（${buf.length} > ${blockSize}）`);
  const hash = sha256(buf);
  return { algorithm: 'SHA256', hash, blockSize, blocks: [hash] };
}

/** 读出归档内某个文件的字节。 */
export function readEntry(srcPath, entryPath) {
  const fd = fs.openSync(srcPath, 'r');
  try {
    const { header, dataStart } = readArchiveHeader(fd);
    const found = collectFiles(header).find((f) => f.path === entryPath);
    if (found === undefined) return null;
    const e = found.entry;
    if (e.unpacked === true || e.link === true || typeof e.offset !== 'string') return null;
    const buf = Buffer.alloc(e.size);
    fs.readSync(fd, buf, 0, e.size, dataStart + Number(e.offset));
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 重打包 asar：replacements 为 Map<entryPath, Buffer>。
 * 未替换的文件按原顺序流式拷贝，offset 重新顺序分配，integrity 同步重算。
 */
export function repackSync(srcPath, dstPath, replacements = new Map()) {
  const fd = fs.openSync(srcPath, 'r');
  const out = fs.openSync(dstPath, 'w');
  try {
    const { header, dataStart } = readArchiveHeader(fd);
    const all = collectFiles(header);
    const inArchive = all.filter((f) => f.entry.unpacked !== true && f.entry.link !== true);
    for (const f of inArchive) {
      if (typeof f.entry.offset !== 'string') throw new Error(`条目缺少 offset 字段：${f.path}`);
    }
    inArchive.sort((a, b) => Number(a.entry.offset) - Number(b.entry.offset));

    const plan = [];
    let cursor = 0;
    for (const f of inArchive) {
      const oldOffset = Number(f.entry.offset);
      const repl = replacements.get(f.path);
      let size = f.entry.size;
      if (repl !== undefined) {
        size = repl.length;
        f.entry.size = size;
        if (f.entry.integrity !== undefined) f.entry.integrity = integrityOf(repl, f.entry.integrity);
      }
      f.entry.offset = String(cursor);
      plan.push({ path: f.path, oldOffset, size, content: repl });
      cursor += size;
    }

    for (const key of replacements.keys()) {
      if (!all.some((f) => f.path === key)) throw new Error(`替换目标在归档里不存在：${key}`);
    }

    const jsonBuf = Buffer.from(JSON.stringify(header), 'utf8');
    const padLen = (4 - (jsonBuf.length % 4)) % 4;
    // 补齐字节必须是 0x00：V8 的 Pickle 用零填充，Electron 自己产出的归档也是零。
    // 写成 0x20 虽然 Electron 照样能读（它只按 strLen 取 JSON），但会破坏
    // 「零改动重打包 = 逐字节相同」这条自检，那可是整个补丁链最硬的证据。
    const framed = Buffer.alloc(16 + jsonBuf.length + padLen, 0x00);
    framed.writeUInt32LE(4, 0);
    framed.writeUInt32LE(8 + jsonBuf.length + padLen, 4);
    framed.writeUInt32LE(4 + jsonBuf.length + padLen, 8);
    framed.writeUInt32LE(jsonBuf.length, 12);
    jsonBuf.copy(framed, 16);
    fs.writeSync(out, framed, 0, framed.length);

    const buf = Buffer.alloc(CHUNK);
    for (const item of plan) {
      if (item.content !== undefined) {
        fs.writeSync(out, item.content, 0, item.content.length);
        continue;
      }
      let remaining = item.size;
      let pos = dataStart + item.oldOffset;
      while (remaining > 0) {
        const want = Math.min(CHUNK, remaining);
        const got = fs.readSync(fd, buf, 0, want, pos);
        if (got !== want) throw new Error(`读取归档数据不完整：${item.path} 需要 ${want} 字节，实际读到 ${got}`);
        fs.writeSync(out, buf, 0, got);
        pos += got;
        remaining -= got;
      }
    }
    fs.ftruncateSync(out, framed.length + cursor);
    return { entries: plan.length, dataStart: framed.length, dataBytes: cursor, totalBytes: framed.length + cursor };
  } finally {
    fs.closeSync(fd);
    fs.closeSync(out);
  }
}

/** 结构 + 内容校验：确认新归档自洽，且未替换的文件内容与原件一致。 */
export function verifyRepack(srcPath, dstPath, replacements = new Map()) {
  const problems = [];
  const fd = fs.openSync(dstPath, 'r');
  const srcFd = fs.openSync(srcPath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    const { header, dataStart } = readArchiveHeader(fd);
    const srcHeader = readArchiveHeader(srcFd).header;
    const files = collectFiles(header);
    const srcFiles = new Map(collectFiles(srcHeader).map((f) => [f.path, f.entry]));

    let maxEnd = 0;
    let stored = 0;
    for (const f of files) {
      const e = f.entry;
      const s = srcFiles.get(f.path);
      if (s === undefined) { problems.push(`多出条目：${f.path}`); continue; }
      if (e.unpacked !== s.unpacked) problems.push(`unpacked 标志被改动：${f.path}`);
      // 被替换的文件本来就该变（大小、integrity 都在 repack 时重算），只在替换目标之外报差异。
      if (!replacements.has(f.path)) {
        if (e.size !== s.size) problems.push(`大小被意外改动：${f.path} ${s.size} -> ${e.size}`);
        if (e.integrity?.hash !== s.integrity?.hash) problems.push(`integrity 哈希被意外改动：${f.path}`);
      }
      if (e.unpacked === true || e.link === true) continue;
      const off = Number(e.offset);
      maxEnd = Math.max(maxEnd, off + e.size);
      stored++;
    }
    if (dataStart + maxEnd !== fileSize) problems.push(`长度不自洽：dataStart ${dataStart} + maxEnd ${maxEnd} = ${dataStart + maxEnd}，而文件是 ${fileSize}`);

    for (const [p, expect] of replacements) {
      const got = readEntry(dstPath, p);
      if (got === null) { problems.push(`替换目标缺失：${p}`); continue; }
      if (!got.equals(expect)) problems.push(`替换后的内容与预期不符：${p}`);
      const e = files.find((f) => f.path === p).entry;
      if (e.integrity !== undefined && e.integrity.hash !== sha256(expect)) problems.push(`替换目标的 integrity 没有同步更新：${p}`);
    }

    const srcCount = collectFiles(srcHeader).length;
    if (files.length !== srcCount) problems.push(`条目数量发生变化：${srcCount} -> ${files.length}`);
    return { ok: problems.length === 0, problems, files: files.length, stored, fileSize, dataStart };
  } finally {
    fs.closeSync(fd);
    fs.closeSync(srcFd);
  }
}

// ---------------- CLI ----------------
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'extract') {
    const [archive, entry, outFile] = rest;
    const buf = readEntry(archive, entry);
    if (buf === null) { console.error('条目不存在，或它不是归档内实存的文件：', entry); process.exit(1); }
    fs.writeFileSync(outFile, buf);
    console.log(`已提取 ${entry} -> ${outFile}（${buf.length} 字节，sha256 ${sha256(buf)}）`);
  } else if (cmd === 'roundtrip') {
    const [src, dst] = rest;
    const r = repackSync(src, dst, new Map());
    const a = fs.readFileSync(src);
    const b = fs.readFileSync(dst);
    const identical = a.length === b.length && a.equals(b);
    console.log('重打包结果：', r);
    console.log('零改动往返是否逐字节相同：', identical, `（原 ${a.length} 字节，新 ${b.length} 字节）`);
    const v = verifyRepack(src, dst, new Map());
    console.log('校验：', v.ok ? '通过' : v.problems);
    if (!identical) process.exit(2);
  } else if (cmd === 'verify') {
    const [archive] = rest;
    const fd = fs.openSync(archive, 'r');
    const { header, dataStart } = readArchiveHeader(fd);
    const files = collectFiles(header);
    let maxEnd = 0;
    for (const f of files) if (f.entry.unpacked !== true && f.entry.link !== true) maxEnd = Math.max(maxEnd, Number(f.entry.offset) + f.entry.size);
    const fileSize = fs.fstatSync(fd).size;
    fs.closeSync(fd);
    console.log({ 条目数: files.length, 数据起点: dataStart, 数据末端: maxEnd, 文件大小: fileSize, 自洽: dataStart + maxEnd === fileSize });
  } else {
    console.log('用法：asar-lib.mjs extract|roundtrip|verify ...');
    process.exit(1);
  }
}