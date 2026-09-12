import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { DemoFixture, DemoManifest, MediaFile } from '../../contracts/src/index.js';
import { canonicalJson } from '../../contracts/src/index.js';
export const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
function unavailable(): never {
    throw new Error('MEDIA_UNAVAILABLE');
}
function safePath(path: unknown): path is string {
    return typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !/[\\:?%]/.test(path) && !path.includes(String.fromCharCode(0)) && path.split('/').every(part => part !== '.' && part !== '..' && part.length > 0);
}
function contained(root: string, path: string) {
    const rel = relative(root, path);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
export class FixtureCatalog {
    private constructor(private readonly root: string, private readonly data: DemoManifest) {
    }
    get manifest(): DemoManifest {
        return structuredClone(this.data);
    }
    static async open(directory: string): Promise<FixtureCatalog> {
        try {
            const root = await realpath(resolve(directory));
            const manifestPath = join(root, 'MEDIA_MANIFEST.json');
            if ((await lstat(manifestPath)).isSymbolicLink())
                throw Error();
            const raw: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
            if (!raw || typeof raw !== 'object' || !('version' in raw) || raw.version !== 1 || !('files' in raw) || !Array.isArray(raw.files) || !raw.files.length)
                throw Error();
            const files: DemoFixture[] = raw.files.map((f: DemoFixture) => {
                if (!f || typeof f.key !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(f.key) || !safePath(f.path) || typeof f.fixtureKey !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(f.fixtureKey) || !/^[a-f0-9]{64}$/.test(f.sha256) || !['image/png', 'video/mp4'].includes(f.mime) || !Number.isSafeInteger(f.width) || f.width <= 0 || !Number.isSafeInteger(f.height) || f.height <= 0 || typeof f.hasAudio !== 'boolean' || typeof f.source !== 'string' || (f.durationMs !== undefined && (!Number.isSafeInteger(f.durationMs) || f.durationMs <= 0)))
                    throw Error();
                return structuredClone(f);
            });
            if (new Set(files.map(f => f.key)).size !== files.length || new Set(files.map(f => f.fixtureKey)).size !== files.length || new Set(files.map(f => f.path)).size !== files.length)
                throw Error();
            // Validate existing path containment at startup; each read repeats it and verifies bytes.
            for (const f of files) {
                const path = await realpath(join(root, f.path));
                if (!contained(root, path))
                    throw Error();
            }
            return new FixtureCatalog(root, {
                version: 1, files
            });
        }
        catch {
            throw new Error('INVALID_FIXTURE_CATALOG');
        }
    }
    async readFixture(key: string): Promise<{
        media: MediaFile;
        bytes: Buffer;
    }> {
        try {
            const f = this.data.files.find(f => f.key === key);
            if (!f)
                unavailable();
            const path = await realpath(join(this.root, f.path));
            if (!contained(this.root, path) || !(await lstat(path)).isFile())
                unavailable();
            const bytes = await readFile(path);
            if (!bytes.length || sha256(bytes) !== f.sha256)
                unavailable();
            const png = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
            const mp4 = bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp';
            if (f.mime === 'image/png' ? !png || bytes.readUInt32BE(16) !== f.width || bytes.readUInt32BE(20) !== f.height : !mp4)
                unavailable();
            const media: MediaFile = {
                id: `fixture-${f.key}`, workspaceId: 'demo', mediaType: f.mime === 'video/mp4' ? 'video' : 'image', mime: f.mime, byteSize: bytes.length, width: f.width, height: f.height, ...(f.durationMs !== undefined ? {
                    durationMs: f.durationMs
                } : {}), hasAudio: f.hasAudio, objectKey: f.path, sha256: f.sha256, availability: 'available', isDemo: true, fixtureKey: f.fixtureKey
            };
            return {
                media, bytes
            };
        }
        catch {
            return unavailable();
        }
    }
    async readMedia(media: MediaFile): Promise<{
        media: MediaFile;
        bytes: Buffer;
    }> {
        const f = this.data.files.find(f => f.fixtureKey === media.fixtureKey);
        if (!f)
            unavailable();
        const actual = await this.readFixture(f.key);
        // Return only catalog-derived metadata; even MIME/size/id tampering is rejected.
        if (canonicalJson(actual.media) !== canonicalJson(media))
            unavailable();
        return actual;
    }
}
