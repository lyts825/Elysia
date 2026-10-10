import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { AppError, invariant } from '../../../packages/contracts/src/index.js';
import type { FileLocation, FileLocationOptions } from '../../../packages/contracts/src/file-location.js';
import type { ResolvedTextEncoding } from '../../../packages/contracts/src/files.js';
import { fileVersion, openFile, resolveEncoding } from './file-reader.js';

const scanLimit = 8 * 1024 * 1024,
  blockSize = 64 * 1024,
  lineLimit = 16 * 1024;
type Scan = {
  key: string;
  version: string;
  encoding: ResolvedTextEncoding;
  offset: number;
  line: number;
  lineStart: number;
  carry: Buffer;
  overflow: boolean;
  previous: { text: string; offset: number; line: number } | null;
  fence: { marker: string; size: number } | null;
  counts: Map<string, number>;
  found?: { offset: number; line: number };
  touched: number;
};

function targetAnchor(input: string) {
  let anchor: string;
  try {
    anchor = decodeURIComponent(input.replace(/^#/, ''));
  } catch {
    throw new AppError('FILE_ANCHOR', '链接中的位置无法解析。');
  }
  invariant(
    anchor.length > 0 && anchor.length <= 256 && !/[\u0000-\u001f\u007f]/.test(anchor),
    'FILE_ANCHOR',
    '链接位置无效或过长。',
  );
  const match = /^L([1-9]\d*)(?:-L?([1-9]\d*))?$/i.exec(anchor);
  if (!match) return { anchor };
  const line = Number(match[1]),
    endLine = Number(match[2] || match[1]);
  invariant(
    Number.isSafeInteger(line) && Number.isSafeInteger(endLine) && endLine >= line && endLine - line <= 10000,
    'FILE_ANCHOR',
    '行号范围无效，最多定位 10,001 行。',
  );
  return { anchor, line, endLine };
}
function headingSlug(text: string) {
  // Same visible-text slug convention as MarkdownDocument; HTML is skipped there.
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, '')
    .replace(/<((?:https?:|mailto:)[^>]*)>/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/(`+)([^`]+)\1/g, '$2')
    .replace(/(?<![\w\\])_{1,3}([^_]+)_{1,3}(?!\w)/g, '$1')
    .replace(/(?<!\\)\*{1,3}([^*]+)\*{1,3}/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(
      /&(?:amp|lt|gt|quot|apos|nbsp);/g,
      (entity) =>
        ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' })[entity] ||
        entity,
    )
    .replace(/&#(x[\da-f]+|\d+);/gi, (entity, value: string) => {
      const point = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    })
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/g, '$1')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

// Opaque continuations bind a bounded scanner state to one file version and query.
// No document contents leave this service other than the existing paged reader.
export class FileLocator {
  private cursors = new Map<string, Scan>();
  async locate(filename: string, scope: string, options: FileLocationOptions): Promise<FileLocation> {
    const target = targetAnchor(options.anchor),
      signal = options.signal;
    for (const [token, value] of this.cursors)
      if (Date.now() - value.touched > 20 * 60000) this.cursors.delete(token);
    const opened = await openFile(filename, signal);
    try {
      if (options.version && options.version !== opened.version)
        throw new AppError('FILE_CHANGED', '文件已变化，请重新定位。', false, null, 409);
      const prefix = Buffer.alloc(Math.min(opened.stat.size, 4));
      await opened.handle.read(prefix, 0, prefix.length, 0);
      const resolved = resolveEncoding(prefix, options.encoding);
      const key = JSON.stringify([scope, filename, target.anchor, options.encoding || 'auto']);
      const prior = options.cursor ? this.cursors.get(options.cursor) : undefined;
      if (options.cursor) {
        invariant(prior && prior.key === key, 'FILE_LOCATION_CURSOR', '定位已过期，请重新打开链接。');
        if (prior.version !== opened.version)
          throw new AppError('FILE_CHANGED', '文件已变化，请重新定位。', false, null, 409);
      }
      const state: Scan = prior
        ? { ...prior, carry: Buffer.from(prior.carry), counts: new Map(prior.counts) }
        : {
            key,
            version: opened.version,
            encoding: resolved.encoding,
            offset: 0,
            line: 1,
            lineStart: 0,
            carry: Buffer.alloc(0),
            overflow: false,
            previous: null,
            fence: null,
            counts: new Map(),
            touched: Date.now(),
          };
      const validate = async () => {
        signal?.throwIfAborted();
        if (
          fileVersion(await fs.stat(filename)) !== opened.version ||
          fileVersion(await opened.handle.stat()) !== opened.version
        )
          throw new AppError('FILE_CHANGED', '文件已变化，请重新定位。', false, null, 409);
      };
      const result = async (
        status: FileLocation['status'],
        extra: Partial<FileLocation> = {},
      ): Promise<FileLocation> => {
        await validate();
        if (options.cursor) this.cursors.delete(options.cursor);
        let cursor: string | null = null;
        if (status === 'continue') {
          cursor = randomBytes(24).toString('hex');
          state.touched = Date.now();
          this.cursors.set(cursor, state);
          while (this.cursors.size > 32) this.cursors.delete(this.cursors.keys().next().value!);
        }
        return {
          status,
          version: opened.version,
          encoding: resolved.encoding,
          scannedUntil: state.offset,
          totalBytes: opened.stat.size,
          cursor,
          ...extra,
        };
      };
      const soughtSlugs = new Set([target.anchor, target.anchor.replace(/-\d+$/, '')]);
      const heading = (text: string, offset: number, line: number) => {
        const slug = headingSlug(text);
        if (!soughtSlugs.has(slug)) return false;
        const count = state.counts.get(slug) || 0;
        state.counts.set(slug, count + 1);
        if (slug + (count ? '-' + count : '') !== target.anchor) return false;
        state.found = { offset, line };
        return true;
      };
      const consumeLine = (end: number) => {
        if (target.line) {
          if (state.line === target.line) state.found = { offset: state.lineStart, line: state.line };
          return !!state.found && state.line === target.endLine;
        }
        let text = '';
        if (!state.overflow) {
          try {
            text = new TextDecoder(state.encoding, { fatal: true, ignoreBOM: state.lineStart !== 0 })
              .decode(state.carry)
              .replace(/\r$/, '');
          } catch {
            throw new AppError('FILE_ENCODING', '无法按当前编码定位文本，请选择文件实际编码。');
          }
        }
        const fence = /^ {0,3}(`{3,}|~{3,})/.exec(text);
        if (state.fence) {
          if (
            fence &&
            fence[1][0] === state.fence.marker &&
            fence[1].length >= state.fence.size &&
            /^\s*$/.test(text.slice(fence[0].length))
          )
            state.fence = null;
          state.previous = null;
          return false;
        }
        if (fence) {
          state.fence = { marker: fence[1][0], size: fence[1].length };
          state.previous = null;
          return false;
        }
        const atx = /^ {0,3}#{1,6}(?:[ \t]+(.*)|[ \t]*)$/.exec(text);
        let found = false;
        if (atx) found = heading((atx[1] || '').replace(/[ \t]+#+[ \t]*$/, ''), state.lineStart, state.line);
        else if (/^ {0,3}(?:=+|-+)[ \t]*$/.test(text) && state.previous)
          found = heading(state.previous.text, state.previous.offset, state.previous.line);
        state.previous =
          !state.overflow && text.trim() && !/^ {4}|^\t|^ {0,3}(?:>|[-+*] |\d+[.)] )/.test(text)
            ? { text, offset: state.lineStart, line: state.line }
            : null;
        return found;
      };
      const scanEnd = Math.min(opened.stat.size, state.offset + scanLimit);
      const unicode = state.encoding.startsWith('utf-16'),
        step = unicode ? 2 : 1;
      while (state.offset < scanEnd) {
        signal?.throwIfAborted();
        const buffer = Buffer.alloc(Math.min(blockSize, scanEnd - state.offset));
        const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, state.offset);
        invariant(bytesRead > 0, 'FILE_CHANGED', '文件已变化，请重新定位。');
        const bytes = buffer.subarray(0, bytesRead),
          base = state.offset;
        let segment = 0;
        const append = (part: Buffer) => {
          if (state.carry.length + part.length > lineLimit) state.overflow = true;
          if (!state.overflow) state.carry = Buffer.concat([state.carry, part]);
        };
        for (let index = 0; index + step <= bytes.length; index += step) {
          const newline = unicode
            ? state.encoding === 'utf-16le'
              ? bytes[index] === 10 && bytes[index + 1] === 0
              : bytes[index] === 0 && bytes[index + 1] === 10
            : bytes[index] === 10;
          if (!newline) continue;
          append(bytes.subarray(segment, index));
          state.offset = base + index + step;
          if (consumeLine(state.offset))
            return await result('found', {
              ...state.found!,
              endOffset: state.offset,
              endLine: target.endLine,
              anchor: target.line ? undefined : target.anchor,
            });
          state.line++;
          state.lineStart = state.offset;
          state.carry = Buffer.alloc(0);
          state.overflow = false;
          segment = index + step;
        }
        append(bytes.subarray(segment));
        state.offset = base + bytesRead;
      }
      if (state.offset === opened.stat.size) {
        if (state.carry.length || state.overflow || state.lineStart === opened.stat.size) {
          if (consumeLine(state.offset))
            return await result('found', {
              ...state.found!,
              endOffset: state.offset,
              endLine: target.endLine,
              anchor: target.line ? undefined : target.anchor,
            });
        }
        return await result('missing');
      }
      return await result('continue');
    } finally {
      await opened.handle.close();
    }
  }
}
