import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { env } from "./env";

/**
 * Private object storage interface. Objects are NEVER served from a public URL: bytes leave only
 * through /api/media/<signed-token>, which re-checks access. Implement S3 / Supabase Storage
 * (private bucket) behind this interface for production; only `local` exists today.
 */
export interface StorageAdapter {
  put(key: string, data: Buffer): Promise<void>;
  stat(key: string): Promise<{ size: number } | null>;
  read(key: string, range?: { start: number; end: number }): Promise<ReadableStream<Uint8Array>>;
  delete(key: string): Promise<void>;
}

class LocalStorage implements StorageAdapter {
  constructor(private root: string) { fs.mkdirSync(root, { recursive: true }); }
  private resolve(key: string) {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error("invalid storage key");
    return p;
  }
  async put(key: string, data: Buffer) {
    const p = this.resolve(key);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data, { mode: 0o600 });
  }
  async stat(key: string) {
    try { return { size: fs.statSync(this.resolve(key)).size }; } catch { return null; }
  }
  async read(key: string, range?: { start: number; end: number }) {
    return Readable.toWeb(fs.createReadStream(this.resolve(key), range)) as unknown as ReadableStream<Uint8Array>;
  }
  async delete(key: string) {
    try { fs.unlinkSync(this.resolve(key)); } catch { /* already gone */ }
  }
}

let cached: { dir: string; adapter: StorageAdapter } | undefined;
export function getStorage(): StorageAdapter {
  if (env.storageDriver !== "local") {
    throw new Error(`STORAGE_DRIVER="${env.storageDriver}" is not implemented. See docs/PROVIDERS.md.`);
  }
  const dir = path.resolve(process.cwd(), env.storageLocalDir);
  if (!cached || cached.dir !== dir) cached = { dir, adapter: new LocalStorage(dir) };
  return cached.adapter;
}

// ── Upload validation: allowlist + magic-byte sniffing (never trust client MIME/extension) ──
const SIGS: { mime: string; kind: "photo" | "video"; ext: string; test: (b: Buffer) => boolean }[] = [
  { mime: "image/jpeg", kind: "photo", ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/png", kind: "photo", ext: "png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/webp", kind: "photo", ext: "webp", test: (b) => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP" },
  { mime: "image/gif", kind: "photo", ext: "gif", test: (b) => b.subarray(0, 3).toString() === "GIF" },
  { mime: "video/mp4", kind: "video", ext: "mp4", test: (b) => b.subarray(4, 8).toString() === "ftyp" },
  { mime: "video/webm", kind: "video", ext: "webm", test: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
];

export function sniffMedia(buf: Buffer) {
  return SIGS.find((s) => s.test(buf)) ?? null;
}

export function newStorageKey(prefix: string, ext: string) {
  return `${prefix}/${crypto.randomUUID()}.${ext}`;
}
