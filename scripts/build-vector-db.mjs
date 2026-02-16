#!/usr/bin/env node
/**
 * build-vector-db.mjs
 * Build a chunked vector index from markdown files for wiki search.
 *
 * Usage:
 *   node scripts/build-vector-db.mjs \
 *     --source=/path/to/source-root \
 *     --md=markdown \
 *     --output=./public \
 *     --out=vector-db.json \
 *     --dim=256 \
 *     --chunk-size=220 \
 *     --chunk-overlap=30
 */

import fs from 'fs';
import path from 'path';
import { webcrypto } from 'crypto';

const DEFAULT_DIM = 256;
const DEFAULT_OUT = 'vector-db.json';
const DEFAULT_VECTOR_FILE_SUFFIX = '-vectors.bin';
const DEFAULT_CHUNK_SIZE = 220;
const DEFAULT_CHUNK_OVERLAP = 30;
const DEFAULT_MIN_CHUNK = 80;
const DEFAULT_ENCRYPT = false;
const WORD_RE = /[가-힣a-z0-9]+/giu;
const PARAGRAPH_BREAKER_RE = /^(?:\([가-힣a-z0-9]+\)|\([0-9]+\)|\d+[.)]|\d+\)|[①-⑳]|[⑳㉁-㉟]|\[[0-9]+\]|[가-힣]\)|[가-힣]\.)\s+/;
const MAX_CHUNK_TERMS = 1024;

function enforceBlockBoundaries(input) {
    const lines = input.split('\n');
    const out = [];

    for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        const trimmed = line.trim();
        if (trimmed && PARAGRAPH_BREAKER_RE.test(trimmed) && out.length > 0) {
            const prev = out[out.length - 1].trim();
            if (prev) {
                out.push('');
            }
        }
        out.push(line);
    }

    return out.join('\n');
}

function parseArgs(argv) {
    const map = {};
    for (let i = 0; i < argv.length; i++) {
        const item = argv[i];
        if (!item.startsWith('--')) continue;
        const [rawKey, rawValue] = item.replace(/^--/, '').split('=');
        if (rawValue !== undefined) {
            map[rawKey] = rawValue;
            continue;
        }
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
            map[rawKey] = next;
            i += 1;
        } else {
            map[rawKey] = 'true';
        }
    }
    return map;
}

function parseIntSafe(value, fallback) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

function parseBoolean(value, fallback = false) {
    if (value === undefined) return fallback;
    if (typeof value === 'boolean') return value;

    return !['0', 'false', 'off', 'no'].includes(String(value).toLowerCase().trim());
}

async function deriveKey(password, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await webcrypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return webcrypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
}

async function encryptPayload(plain, password) {
    const enc = new TextEncoder();
    const plainBytes = plain instanceof ArrayBuffer
        ? new Uint8Array(plain)
        : enc.encode(plain);
    const salt = webcrypto.getRandomValues(new Uint8Array(16));
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plainBytes);

    return {
        salt: Buffer.from(salt).toString('base64'),
        iv: Buffer.from(iv).toString('base64'),
        ciphertext: Buffer.from(ciphertext).toString('base64'),
    };
}

function dirExists(target) {
    return fs.existsSync(target) && fs.statSync(target).isDirectory();
}

function hasMarkdownInDir(target) {
    if (!dirExists(target)) return false;

    const entries = fs.readdirSync(target, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory() && entry.isFile() && entry.name.endsWith('.md')) return true;
    }
    return false;
}

function resolveSourceRoot(rawSource) {
    if (rawSource) {
        const explicit = path.resolve(process.cwd(), rawSource);
        if (!fs.existsSync(explicit)) {
            throw new Error(`Source folder not found: ${explicit}`);
        }
        return explicit;
    }

    const candidates = [
        path.resolve(process.cwd(), '..', 'docs'),
        path.resolve(process.cwd(), '..', 'doc'),
        path.resolve(process.cwd(), 'doc'),
        path.resolve(process.cwd(), 'docs'),
    ];

    for (const candidate of candidates) {
        if (dirExists(candidate)) {
            return candidate;
        }
    }

    throw new Error('No markdown source folder found. Please set --source explicitly.');
}

function resolveMarkdownRoot(sourceRoot, mdRootArg) {
    const preferred = path.resolve(sourceRoot, mdRootArg);
    if (dirExists(preferred)) return preferred;

    const fallbackTargets = [
        sourceRoot,
        path.join(sourceRoot, 'wiki'),
        path.join(sourceRoot, 'markdown'),
    ];

    for (const candidate of fallbackTargets) {
        if (hasMarkdownInDir(candidate)) {
            return candidate;
        }
    }

    if (fs.existsSync(preferred)) return preferred;

    throw new Error(`No markdown root found under source: ${sourceRoot} (md=${mdRootArg}).`);
}

function tokenize(input) {
    return (input.match(WORD_RE) || []).map(v => v.trim().toLowerCase()).filter(Boolean);
}

function normalizeMarkdown(input) {
    const prepared = input
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\r\n/g, '\n')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .trim();

    return enforceBlockBoundaries(prepared);
}

function splitTextByParagraphs(input) {
    const lines = normalizeMarkdown(input).split('\n');
    const blocks = [];
    let current = [];

    const flush = () => {
        const text = current.join('\n').trim();
        if (!text) return;
        blocks.push(text);
        current = [];
    };

    for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        const trimmed = line.trim();
        if (!trimmed) {
            flush();
            continue;
        }
        if (current.length > 0 && PARAGRAPH_BREAKER_RE.test(trimmed)) {
            flush();
        }
        current.push(line);
    }

    flush();
    return blocks.filter(Boolean);
}

function stableHash32(input) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

function toVector(tokens, dim) {
    // Note: In a real implementation with BM25 weights, this would use the Wasm engine.
    // For this build script, we'll keep the hashing as a fallback or metadata.
    const vec = new Float64Array(dim);
    for (const token of tokens) {
        const h = stableHash32(token);
        const idx = h % dim;
        const sign = (h & 1) === 0 ? -1 : 1;
        vec[idx] += sign;
    }

    let norm = 0;
    for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;

    const out = new Float64Array(dim);
    for (let i = 0; i < dim; i++) out[i] = vec[i] / norm;
    return Array.from(out);
}

function uniqueSortedTokens(tokens) {
    if (!tokens.length) return [];
    const set = new Set(tokens);
    return Array.from(set);
}

function titleFromSlug(slug) {
    const base = slug.split('/').pop() || slug;
    return base
        .replace(/^\d+-/, '')
        .replace(/--/g, ' – ')
        .replace(/-/g, ' ')
        .replace(/\.md$/i, '');
}

function pathFromSlug(slug) {
    return slug
        .split('/')
        .map(v => v.replace(/^\d+-/, '').replace(/--/g, ' – ').replace(/-/g, ' ').replace(/\.md$/i, ''))
        .slice(0, -1)
        .join(' / ');
}

function splitByHeadings(input) {
    const lines = normalizeMarkdown(input).split('\n');
    const stacks = [];
    const chunks = [];
    let sectionLabel = '본문';
    const buffer = [];

    const flush = () => {
        const text = buffer.join('\n').trim();
        if (!text) return;
        chunks.push({ section: sectionLabel, text });
        buffer.length = 0;
    };

    const labelFromStack = () => stacks.map(item => item.title).join(' > ') || '본문';

    for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        const heading = line.match(/^(#{1,6})\s+(.*?)\s*$/);
        if (heading) {
            flush();
            const level = heading[1].length;
            const title = heading[2].trim();

            while (stacks.length && stacks[stacks.length - 1].level >= level) {
                stacks.pop();
            }
            stacks.push({ level, title });
            sectionLabel = labelFromStack();
            buffer.push(title);
            continue;
        }
        buffer.push(line);
    }

    flush();
    return chunks.filter(v => v.text.trim().length > 0);
}

function chunkByParagraphs(text, chunkSize, minChunk) {
    const chunks = [];
    const paragraphs = splitTextByParagraphs(text);
    if (!paragraphs.length) return chunks;

    const size = Math.max(1, chunkSize);
    let current = [];
    let currentTokens = 0;

    const flush = () => {
        if (!current.length) return;
        chunks.push(current.join('\n\n'));
        current = [];
        currentTokens = 0;
    };

    for (const paragraph of paragraphs) {
        const tokens = tokenize(paragraph);
        const count = tokens.length;
        if (!count) continue;

        if (!current.length) {
            current.push(paragraph);
            currentTokens = count;
            if (count >= size) {
                flush();
            }
            continue;
        }

        if (currentTokens + 1 + count > size) {
            flush();
            current.push(paragraph);
            currentTokens = count;
            if (count >= size) {
                flush();
            }
            continue;
        }

        current.push(paragraph);
        currentTokens += count + 1;
    }

    if (current.length) flush();
    if (!chunks.length) return chunks;
    return chunks.filter((chunk, index) => tokenize(chunk).length >= minChunk || index === chunks.length - 1);
}

function readTextFilesRecursively(root, base = root, out = []) {
    if (!fs.existsSync(root)) return out;
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'content-manifest.json' || e.name === 'INDEX.md') continue;
        const full = path.join(root, e.name);
        const rel = path.relative(base, full);
        if (e.isDirectory()) {
            readTextFilesRecursively(full, base, out);
            continue;
        }
        if (!e.isFile() || !e.name.endsWith('.md')) continue;
        out.push({ relPath: rel.replace(/\\/g, '/'), absPath: full });
    }
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const source = resolveSourceRoot(args.source);
    const mdRoot = args.md || 'markdown';
    const outputRoot = path.resolve(process.cwd(), args.output || 'public');
    const outFile = args.out || DEFAULT_OUT;
    const outFilePath = path.resolve(outputRoot, outFile);
    const vectorFileArg = args['vector-file'];
    const vectorFile = vectorFileArg || `${path.parse(outFile).name}${DEFAULT_VECTOR_FILE_SUFFIX}`;
    const vectorFilePath = path.resolve(path.dirname(outFilePath), vectorFile);
    const vectorFilePathToSave = `${vectorFilePath}.enc`;
    const dim = parseIntSafe(args.dim || `${DEFAULT_DIM}`, DEFAULT_DIM);
    const chunkSize = parseIntSafe(args['chunk-size'] || `${DEFAULT_CHUNK_SIZE}`, DEFAULT_CHUNK_SIZE);
    const chunkOverlap = parseIntSafe(args['chunk-overlap'] || `${DEFAULT_CHUNK_OVERLAP}`, DEFAULT_CHUNK_OVERLAP);
    const mdDir = resolveMarkdownRoot(source, mdRoot);
    const shouldEncrypt = parseBoolean(args.encrypt || args['encrypt-vector'], DEFAULT_ENCRYPT);
    const passwordEnv = args['password-env'];
    const password = args.password
        || (passwordEnv ? process.env[passwordEnv] : undefined)
        || process.env.WIKI_PASSWORD
        || process.env.WIKI_ENCRYPTION_PASSWORD;

    if (shouldEncrypt && !password) {
        throw new Error('Vector DB encryption enabled but no password provided. Use --password or --password-env.');
    }

    console.log('📦 vector index build');
    console.log(`  source root: ${source}`);
    console.log(`  markdown: ${mdRoot}`);
    console.log(`  output: ${outputRoot}`);
    console.log(`  chunk-size: ${chunkSize}, overlap: ${chunkOverlap}, dim: ${dim}`);
    console.log(`  encrypted: ${shouldEncrypt}`);

    const targetDir = mdDir;
    const files = readTextFilesRecursively(targetDir);
    const chunks = [];
    const postings = new Map();
    const vectorRows = [];
    let totalTokens = 0;
    let totalDocs = 0;

    // --- BM25 Stats Collection ---
    const dfMap = new Map(); // token -> document count
    const docTokenCounts = []; // lengths of all chunks
    let totalChunkTokens = 0;

    console.log('📊 calculating corpus statistics (DF/IDF)...');
    for (const f of files) {
        const markdown = fs.readFileSync(f.absPath, 'utf-8');
        const sections = splitByHeadings(markdown);
        for (const section of sections) {
            const parts = chunkByParagraphs(section.text, chunkSize, DEFAULT_MIN_CHUNK);
            for (const part of parts) {
                const tokens = tokenize(part);
                if (!tokens.length) continue;

                const uniqueInDoc = new Set(tokens);
                for (const t of uniqueInDoc) {
                    dfMap.set(t, (dfMap.get(t) || 0) + 1);
                }
                docTokenCounts.push(tokens.length);
                totalChunkTokens += tokens.length;
            }
        }
    }

    if (!docTokenCounts.length) {
        throw new Error('No tokenized chunks found while building corpus stats');
    }

    const avgdl = totalChunkTokens / docTokenCounts.length;
    const idfMap = {};
    const N = docTokenCounts.length;
    if (!N) {
        throw new Error('Invalid corpus size for BM25 stats');
    }
    for (const [token, df] of dfMap.entries()) {
        // BM25 IDF variant: log((N - df + 0.5) / (df + 0.5) + 1)
        idfMap[token] = Math.log((N - df + 0.5) / (df + 0.5) + 1);
    }
    // --- End Stats ---

    for (const f of files) {
        const markdown = fs.readFileSync(f.absPath, 'utf-8');
        const text = normalizeMarkdown(markdown);
        const title = titleFromSlug(f.relPath);
        const pathText = pathFromSlug(f.relPath);
        const slug = f.relPath.replace(/\.md$/, '');
        const sections = splitByHeadings(markdown);
        totalDocs += 1;
        let chunkIndex = 0;

        for (const section of sections) {
            const tokens = tokenize(section.text);
            if (!tokens.length) continue;
            const parts = chunkByParagraphs(section.text, chunkSize, DEFAULT_MIN_CHUNK);
            for (const part of parts) {
                const partTokens = tokenize(part);
                if (!partTokens.length) continue;
                totalTokens += partTokens.length;
                const uniquePartTokens = uniqueSortedTokens(partTokens).slice(0, MAX_CHUNK_TERMS);
                for (const token of uniquePartTokens) {
                    const list = postings.get(token);
                    if (list) {
                        list.push(chunks.length);
                    } else {
                        postings.set(token, [chunks.length]);
                    }
                }
                chunks.push({
                    id: `${slug}::${chunkIndex}`,
                    slug,
                    title,
                    path: pathText,
                    section: `${section.section} ${chunkIndex > 0 ? `(chunk ${chunkIndex + 1})` : ''}`.trim(),
                    source: 'content',
                    preview: part.length > 220 ? `${part.slice(0, 220)}...` : part,
                    terms: uniquePartTokens,
                });
                vectorRows.push(toVector(partTokens, dim));
                chunkIndex += 1;
            }
        }
    }

    if (!vectorRows.length) {
        throw new Error('No vectors found while building chunks');
    }

    const flattened = new Float32Array(vectorRows.length * dim);
    let vectorCursor = 0;
    for (const vector of vectorRows) {
        if (vector.length !== dim) {
            throw new Error(`Vector dimension mismatch while serializing: expected ${dim}, got ${vector.length}`);
        }
        for (const value of vector) {
            flattened[vectorCursor] = Number(value);
            vectorCursor += 1;
        }
    }

    const postingsPayload = {};
    for (const [token, ids] of postings.entries()) {
        postingsPayload[token] = ids;
    }

    const outDir = path.dirname(outFilePath);
    const outputVectorPath = shouldEncrypt
        ? (vectorFile.toLowerCase().endsWith('.enc') ? vectorFilePath : vectorFilePathToSave)
        : vectorFilePath;
    const vectorFileName = path.relative(outDir, outputVectorPath).replace(/\\/g, '/');
    const vectorPayloadFile = shouldEncrypt
        ? outputVectorPath
        : vectorFilePath;

    const payload = {
        version: '0.5.0',
        dimensions: dim,
        metric: 'cosine',
        createdAt: new Date().toISOString(),
        vectors: {
            file: vectorFileName,
            format: 'f32',
            dimensions: dim,
            byteLength: flattened.byteLength,
            encrypted: shouldEncrypt,
        },
        chunks,
        postings: postingsPayload,
        bm25: {
            avgdl,
            idf: idfMap,
            N,
        },
        stats: {
            docCount: totalDocs,
            chunkCount: chunks.length,
            tokenCount: totalTokens,
        },
    };

    fs.mkdirSync(outputRoot, { recursive: true });
    if (shouldEncrypt && password) {
        const encrypted = await encryptPayload(flattened.buffer.slice(0), password);
        fs.writeFileSync(vectorPayloadFile, JSON.stringify(encrypted));
    } else {
        fs.writeFileSync(vectorPayloadFile, Buffer.from(flattened.buffer));
    }

    const finalPayload = shouldEncrypt && password
        ? await encryptPayload(JSON.stringify(payload), password)
        : payload;

    fs.writeFileSync(outFilePath, JSON.stringify(finalPayload));
    console.log(`✅ saved: ${outFilePath}`);
    console.log(`✅ vectors: ${vectorPayloadFile}`);
    console.log(`  ✅ docs: ${totalDocs}, chunks: ${chunks.length}, dim: ${dim}`);
    console.log(`  ✅ vector file: ${vectorFileName}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
