import { getWasmEngine } from './wasm-engine.js';
import {
    calculateBM25WeightsFromTokens,
    requireBm25Stats,
} from './rag-bm25.js';
import {
    decryptPayloadBytes,
    decryptPayloadToJson,
    isEncryptedPayload,
    type EncryptedPayload,
} from './crypto.js';

export type VectorSearchSource = 'content';

export interface VectorChunk {
    id: string;
    slug: string;
    title: string;
    path: string;
    section: string;
    sectionPath: string;
    anchor: string;
    sectionIndex: number;
    source: VectorSearchSource;
    text?: string;
    preview: string;
    terms?: string[];
    vector?: number[] | Float32Array;
}

interface Bm25Stats {
    avgdl: number;
    idf: Record<string, number>;
    N: number;
}

type WasmEmbedder = {
    embed_batch: (texts: string[], normalize: boolean, weights: unknown) => Float32Array;
};

type InvertedPostings = Record<string, number[]>;

type VectorPayload = {
    file: string;
    format: 'f32';
    dimensions: number;
    byteLength?: number;
    byteOffset?: number;
    encrypted?: boolean;
};

type VectorAccessor = number[] | Float32Array;

type VectorStoreRuntime = {
    chunks: Float32Array;
    sourceUrl: string;
};

export interface VectorSearchIndex {
    version: string;
    dimensions: number;
    metric: 'cosine';
    createdAt: string;
    vectorStore?: VectorPayload;
    hasInlineVectors?: boolean;
    _metadataUrl?: string;
    _vectorStoreUrl?: string;
    _vectorStoreLoaded?: boolean;
    _vectorDbPassword?: string;
    bm25?: Bm25Stats;
    postings?: InvertedPostings;
    stats: {
        docCount: number;
        chunkCount: number;
        tokenCount: number;
    };
    chunks: VectorChunk[];
}

export interface VectorSearchHit {
    slug: string;
    title: string;
    path: string;
    section: string;
    sectionPath: string;
    anchor: string;
    snippet: string;
    score: number;
    matchedTerms: string[];
}

export interface VectorBuildInput {
    slugs: string[];
    inferTitle: (slug: string) => string;
    inferPath: (slug: string) => string;
    getDocumentText: (slug: string) => Promise<string | null>;
    dim?: number;
    maxTokensPerChunk?: number;
    chunkOverlapTokens?: number;
    minTokensPerChunk?: number;
    bm25SourceUrl?: string;
    bm25Password?: string;
    onProgress?: (done: number, total: number, percent: number) => void;
}

export interface HeadingAnchor {
    id: string;
    text: string;
    level: number;
    sectionIndex: number;
}

export interface ChunkAnchor {
    id: string;
    sectionIndex: number;
    headingId: string;
    startParagraph: number;
    endParagraph: number;
    section: string;
    sectionPath: string;
}

export interface ContentNavigationPlan {
    headings: HeadingAnchor[];
    chunkAnchors: ChunkAnchor[];
}

interface ChunkMeta {
    section: string;
    sectionPath: string;
    text: string;
    sectionIndex: number;
    sectionLevel: number;
}

interface ParagraphChunk {
    text: string;
    startParagraph: number;
    endParagraph: number;
    partIndex: number;
}

interface SectionPlan {
    section: ChunkMeta;
    headingId: string;
    hasHeading: boolean;
    paragraphs: string[];
    chunks: ParagraphChunk[];
}

const DEFAULT_DIM = 256;
const DEFAULT_MAX_TOKENS = 220;
const DEFAULT_MIN_TOKENS = 80;
const DEFAULT_OVERLAP = 30;
const MAX_CANDIDATE_CHUNKS = 1800;

const VECTOR_STORE_CACHE = new WeakMap<VectorSearchIndex, Promise<VectorStoreRuntime>>();

const WORD_RE = /[가-힣a-z0-9]+/giu;
const PARAGRAPH_BREAKER_RE = /^(?:\([가-힣a-z0-9]+\)|\([0-9]+\)|\d+[.)]|\d+\)|[①-⑳]|[⑳㉁-㉟]|\[[0-9]+\]|[가-힣]\)|[가-힣]\.)\s+/;

function enforceBlockBoundaries(input: string): string {
    const lines = input.split('\n');
    const out: string[] = [];

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

function tokenize(input: string): string[] {
    return (input.match(WORD_RE) || []).map(v => v.trim().toLowerCase()).filter(Boolean);
}

function stableHash32(input: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

function normalizeMarkdown(input: string): string {
    const prepared = input
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\r\n/g, '\n')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .trim();

    return enforceBlockBoundaries(prepared);
}

export function normalizeContentForChunking(input: string): string {
    return normalizeMarkdown(input);
}

function flattenForSearch(input: string): string {
    return normalizeMarkdown(input).replace(/\n+/g, '\n');
}

function sectionAnchorId(sectionIndex: number): string {
    return `h-${sectionIndex}`;
}

function splitByHeadings(input: string): Array<ChunkMeta> {
    const lines = normalizeMarkdown(input).split('\n');
    const chunks: Array<ChunkMeta> = [];
    const levelStack: Array<{ level: number; title: string }> = [];
    let currentSection = '본문';
    let currentSectionPath = '본문';
    let currentSectionIndex = 0;
    let currentSectionLevel = 0;
    const currentBuffer: string[] = [];

    const flush = () => {
        const text = currentBuffer.join('\n').trim();
        if (!text) return;
        chunks.push({
            section: currentSection,
            sectionPath: currentSectionPath,
            text,
            sectionIndex: currentSectionIndex,
            sectionLevel: currentSectionLevel,
        });
        currentBuffer.length = 0;
    };

    const sectionLabel = () => {
        const labels = levelStack.map(item => item.title).filter(Boolean);
        return labels.length ? labels.join(' > ') : '본문';
    };

    for (const raw of lines) {
        const line = raw.trimEnd();
        const headingMatch = line.match(/^(#{1,6})\s+(.*?)\s*$/);
        if (headingMatch) {
            flush();
            const level = headingMatch[1].length;
            const title = headingMatch[2].trim();

            while (levelStack.length && levelStack[levelStack.length - 1].level >= level) {
                levelStack.pop();
            }
            levelStack.push({ level, title });
            currentSectionIndex += 1;
            currentSection = title;
            currentSectionLevel = level;
            currentSectionPath = sectionLabel();
            currentBuffer.push(title);
            continue;
        }

        currentBuffer.push(line);
    }

    flush();
    return chunks.filter(chunk => chunk.text.trim().length > 0);
}

function splitTextByParagraphs(input: string): string[] {
    const lines = normalizeMarkdown(input).split('\n');
    const blocks: string[] = [];
    let currentBlock: string[] = [];

    const flush = () => {
        const text = currentBlock.join('\n').trim();
        if (!text) return;
        blocks.push(text);
        currentBlock = [];
    };

    for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        const trimmed = line.trim();

        if (!trimmed) {
            flush();
            continue;
        }

        if (currentBlock.length > 0 && PARAGRAPH_BREAKER_RE.test(trimmed)) {
            flush();
        }

        currentBlock.push(line);
    }

    flush();
    return blocks.filter(Boolean);
}

function chunkTextByParagraphs(
    paragraphs: string[],
    options: Required<Pick<VectorBuildInput, 'maxTokensPerChunk' | 'chunkOverlapTokens' | 'minTokensPerChunk'>>,
): ParagraphChunk[] {
    if (!paragraphs.length) return [];

    const chunkSize = Math.max(1, options.maxTokensPerChunk);
    const chunks: ParagraphChunk[] = [];
    let currentParagraphs: string[] = [];
    let currentStart = 0;
    let currentTokens = 0;
    let partIndex = 0;

    const flush = (endExclusive: number) => {
        if (!currentParagraphs.length) return;
        chunks.push({
            text: currentParagraphs.join('\n\n'),
            startParagraph: currentStart,
            endParagraph: endExclusive - 1,
            partIndex,
        });
        partIndex += 1;
        currentParagraphs = [];
        currentTokens = 0;
        currentStart = endExclusive;
    };

    for (let i = 0; i < paragraphs.length; i += 1) {
        const paragraph = paragraphs[i];
        const tokenCount = tokenize(paragraph).length;
        if (!tokenCount) continue;

        if (!currentParagraphs.length) {
            currentParagraphs.push(paragraph);
            currentStart = i;
            currentTokens = tokenCount;

            if (tokenCount >= chunkSize) {
                flush(i + 1);
            }
            continue;
        }

        if (currentTokens + 1 + tokenCount > chunkSize) {
            flush(i);
            currentParagraphs.push(paragraph);
            currentTokens = tokenCount;

            if (tokenCount >= chunkSize) {
                flush(i + 1);
            }
            continue;
        }

        currentParagraphs.push(paragraph);
        currentTokens += tokenCount + 1;
    }

    if (currentParagraphs.length) {
        flush(paragraphs.length);
    }

    return chunks;
}

function weightedVectorFromTokens(tokens: string[], weights: number[], dim: number): number[] {
    if (!tokens.length || tokens.length !== weights.length) return [];

    const vec = new Float64Array(dim);
    const safeDim = Math.max(1, dim);
    let norm = 0;

    for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        const weight = weights[i];
        if (!token || !Number.isFinite(weight)) continue;

        const h = stableHash32(token);
        const idx = h % safeDim;
        const sign = (h & 1) === 0 ? -1 : 1;
        vec[idx] += weight * sign;
    }

    for (let i = 0; i < safeDim; i += 1) {
        norm += vec[i] * vec[i];
    }
    norm = Math.sqrt(norm) || 1;

    const out = new Float64Array(safeDim);
    for (let i = 0; i < safeDim; i += 1) {
        out[i] = vec[i] / norm;
    }
    return Array.from(out);
}

function buildSectionChunkPlans(
    content: string,
    options: Required<Pick<VectorBuildInput, 'maxTokensPerChunk' | 'chunkOverlapTokens' | 'minTokensPerChunk'>>,
): SectionPlan[] {
    const sections = splitByHeadings(content);

    return sections.map((section) => {
        const paragraphs = splitTextByParagraphs(section.text);
        const chunks = chunkTextByParagraphs(paragraphs, options);

        return {
            section,
            headingId: sectionAnchorId(section.sectionIndex),
            hasHeading: section.sectionLevel > 0,
            paragraphs,
            chunks,
        };
    });
}

export function buildContentNavigationPlan(input: string): ContentNavigationPlan {
    const sectionPlans = buildSectionChunkPlans(input, {
        maxTokensPerChunk: DEFAULT_MAX_TOKENS,
        chunkOverlapTokens: DEFAULT_OVERLAP,
        minTokensPerChunk: DEFAULT_MIN_TOKENS,
    });

    const headings: HeadingAnchor[] = [];
    const chunkAnchors: ChunkAnchor[] = [];
    let paragraphCursor = 0;

    for (const sectionPlan of sectionPlans) {
        if (sectionPlan.hasHeading) {
            headings.push({
                id: sectionPlan.headingId,
                text: sectionPlan.section.section,
                level: sectionPlan.section.sectionLevel,
                sectionIndex: sectionPlan.section.sectionIndex,
            });
        }

        sectionPlan.chunks.forEach((chunk) => {
            const anchor = chunk.partIndex === 0
                ? sectionPlan.headingId
                : `${sectionPlan.headingId}-p${chunk.partIndex + 1}`;

            chunkAnchors.push({
                id: anchor,
                sectionIndex: sectionPlan.section.sectionIndex,
                headingId: sectionPlan.headingId,
                startParagraph: paragraphCursor + chunk.startParagraph,
                endParagraph: paragraphCursor + chunk.endParagraph,
                section: sectionPlan.section.section,
                sectionPath: sectionPlan.section.sectionPath,
            });
        });

        paragraphCursor += sectionPlan.paragraphs.length;
    }

    if (!headings.length) {
        headings.push({
            id: sectionAnchorId(0),
            text: '본문',
            level: 1,
            sectionIndex: 0,
        });
    }

    return { headings, chunkAnchors };
}

function normalizeIndexChunk(raw: unknown): VectorChunk {
    const candidate = raw as Record<string, unknown>;
    if (!candidate || typeof candidate !== 'object') {
        throw new Error('Invalid vector chunk');
    }

    const id = `${candidate.id ?? ''}`;
    const slug = `${candidate.slug ?? ''}`;
    const title = `${candidate.title ?? ''}`;
    const path = `${candidate.path ?? ''}`;
    const section = `${candidate.section ?? ''}`;
    const sectionPath = `${candidate.sectionPath ?? ''}`;
    const anchor = `${candidate.anchor ?? ''}`;

    const sectionIndex = Number(candidate.sectionIndex);
    const source = candidate.source === 'content' ? 'content' : 'content';
    const preview = `${candidate.preview ?? ''}`;
    const text = typeof candidate.text === 'string' ? candidate.text : undefined;
    const vectorRaw = candidate.vector;
    const terms = Array.isArray(candidate.terms)
        ? candidate.terms.map((term) => `${term}`.trim().toLowerCase()).filter(Boolean)
        : undefined;

    let vector: VectorAccessor | undefined;
    if (vectorRaw !== undefined) {
        if (Array.isArray(vectorRaw) && vectorRaw.length > 0) {
            vector = vectorRaw.map((value) => Number(value));
        } else if (vectorRaw instanceof Float32Array && vectorRaw.length > 0) {
            vector = vectorRaw;
        } else if (vectorRaw) {
            throw new Error(`Invalid vector for chunk ${id}`);
        }

        if (!vector || vector.some((value) => !Number.isFinite(Number(value)))) {
            throw new Error(`Invalid vector data for chunk ${id}`);
        }
    }

    return {
        id,
        slug,
        title,
        path,
        section,
        sectionPath,
        anchor,
        sectionIndex: Number.isFinite(sectionIndex) ? sectionIndex : 0,
        source,
        text,
        preview: preview || text?.slice(0, 240) || '',
        terms,
        vector,
    };
}

function normalizePostings(raw: unknown): InvertedPostings | undefined {
    if (!raw || typeof raw !== 'object') return undefined;

    const postings: InvertedPostings = {};
    const entries = Object.entries(raw as Record<string, unknown>);

    for (const [token, rawIds] of entries) {
        if (!token || typeof token !== 'string') continue;
        if (!Array.isArray(rawIds)) continue;

        const ids = rawIds
            .map((value) => Number(value))
            .filter((value) => Number.isInteger(value) && value >= 0 && Number.isFinite(value));

        if (!ids.length) continue;
        postings[token.trim().toLowerCase()] = Array.from(new Set(ids)).sort((a, b) => a - b);
    }

    return Object.keys(postings).length ? postings : undefined;
}

function normalizeVectorStore(raw: unknown): VectorPayload | undefined {
    if (!raw || typeof raw !== 'object') return undefined;

    const source = raw as Record<string, unknown>;
    if (typeof source.file !== 'string' || !source.file.trim()) {
        return undefined;
    }

    const format = `${source.format ?? 'f32'}`.trim().toLowerCase();
    if (format !== 'f32' && format !== 'float32') {
        return undefined;
    }

    const dimensions = Number(source.dimensions);
    if (!Number.isFinite(dimensions) || dimensions <= 0) return undefined;

    return {
        file: source.file.trim(),
        format: 'f32',
        dimensions,
        byteLength: Number.isFinite(Number(source.byteLength)) ? Number(source.byteLength) : undefined,
        byteOffset: Number.isFinite(Number(source.byteOffset)) ? Number(source.byteOffset) : undefined,
        encrypted: typeof source.encrypted === 'boolean' ? source.encrypted : undefined,
    };
}

async function loadVectorPayload<T>(indexUrl: string, password?: string): Promise<T> {
    const res = await fetch(indexUrl, { cache: 'force-cache' });
    if (!res.ok) {
        throw new Error(`vector-db fetch failed (${res.status} ${res.statusText})`);
    }

    const rawText = await res.text();
    let rawPayload: unknown;
    try {
        rawPayload = JSON.parse(rawText);
    } catch {
        throw new Error(`vector-db payload is not valid JSON: ${indexUrl}`);
    }

    if (isEncryptedPayload(rawPayload)) {
        if (!password) {
            throw new Error('Vector DB metadata is encrypted. Please provide password.');
        }

        return decryptPayloadToJson<T>(password, rawPayload as EncryptedPayload);
    }

    return rawPayload as T;
}

function resolveVectorUrl(indexUrl: string, file: string): string {
    const raw = file.trim();
    if (!raw) return '';

    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.startsWith('/')) {
        return raw;
    }

    if (!indexUrl) {
        return raw;
    }

    const lastSlash = indexUrl.lastIndexOf('/');
    if (lastSlash >= 0) {
        const base = indexUrl.slice(0, lastSlash + 1);
        return `${base}${raw}`;
    }

    return raw;
}

async function loadVectorStore(index: VectorSearchIndex): Promise<VectorStoreRuntime> {
    const existing = VECTOR_STORE_CACHE.get(index);
    if (existing) return existing;

    const vectorStore = index.vectorStore;
    if (!vectorStore) {
        throw new Error('No vector store metadata in DB');
    }

    if (!index._vectorStoreUrl && index._metadataUrl) {
        index._vectorStoreUrl = resolveVectorUrl(index._metadataUrl, vectorStore.file);
    }

    const sourceUrl = index._vectorStoreUrl;
    if (!sourceUrl) {
        throw new Error('Invalid vector store file path');
    }

    const loadPromise = (async () => {
        const res = await fetch(sourceUrl, { cache: 'force-cache' });
        if (!res.ok) {
            throw new Error(`vector store fetch failed (${res.status} ${res.statusText})`);
        }

        const rawBuffer = vectorStore.encrypted
            ? await (async () => {
                if (!index._vectorDbPassword) {
                    throw new Error('Vector store is encrypted. Please provide password.');
                }

                const encrypted = await res.json();
                if (!isEncryptedPayload(encrypted)) {
                    throw new Error(`Invalid encrypted vector store payload: ${sourceUrl}`);
                }

                return await decryptPayloadBytes(index._vectorDbPassword, encrypted as EncryptedPayload);
            })()
            : await res.arrayBuffer();

        const vectors = new Float32Array(rawBuffer);
        const expectedLength = index.chunks.length * index.dimensions;

        if (vectors.length < expectedLength) {
            throw new Error(`Vector store too small: expected at least ${expectedLength} values, got ${vectors.length}`);
        }
        if (vectorStore.dimensions !== index.dimensions) {
            throw new Error(`Vector store dimension mismatch: ${vectorStore.dimensions} != ${index.dimensions}`);
        }
        if (vectorStore.byteOffset && Number.isFinite(vectorStore.byteOffset)) {
            const start = vectorStore.byteOffset;
            const bytes = rawBuffer.slice(start);
            const sliced = new Float32Array(bytes);
            if (sliced.length < expectedLength) {
                throw new Error(`Vector store byteOffset(${start}) makes slice too small`);
            }
            index._vectorStoreLoaded = true;
            return { chunks: sliced.subarray(0, expectedLength), sourceUrl };
        }

        index._vectorStoreLoaded = true;
        return { chunks: vectors.subarray(0, expectedLength), sourceUrl };
    })();

    const guarded = loadPromise.catch((error) => {
        VECTOR_STORE_CACHE.delete(index);
        throw error;
    });
    VECTOR_STORE_CACHE.set(index, guarded);
    return guarded;
}

export async function ensureVectorStoreLoaded(index: VectorSearchIndex): Promise<void> {
    await loadVectorStore(index);
}

function getChunkVector(
    index: VectorSearchIndex,
    chunk: VectorChunk,
    chunkIndex: number,
    vectorStore: Float32Array | null,
): VectorAccessor | null {
    if (chunk.vector) {
        return chunk.vector;
    }

    if (!vectorStore) return null;
    const start = chunkIndex * index.dimensions;
    const end = start + index.dimensions;
    if (!Number.isFinite(start) || end > vectorStore.length) return null;
    return vectorStore.subarray(start, end);
}

export async function loadPrebuiltVectorIndex(
    indexUrl = '/vector-db.json',
    password?: string,
): Promise<VectorSearchIndex> {
    const payload = await loadVectorPayload<Record<string, unknown>>(indexUrl, password);
    const bm25 = requireBm25Stats(payload?.bm25) as Bm25Stats;

    const chunksRaw = (Array.isArray(payload?.chunks) ? payload.chunks : []) as unknown[];
    if (!chunksRaw.length) {
        throw new Error('No chunks found in vector DB');
    }

    const dimensions = Number(payload?.dimensions);
    if (!Number.isFinite(dimensions) || dimensions <= 0) {
        throw new Error('Invalid vector dimension in vector DB');
    }

    const chunks: VectorChunk[] = chunksRaw.map((chunk: unknown) => normalizeIndexChunk(chunk));
    const hasInlineVectors = chunks.every((chunk: VectorChunk) => chunk.vector !== undefined);
    const vectorStore = normalizeVectorStore(payload?.vectors);
    const vectorDbPassword = vectorStore?.encrypted ? password : undefined;
    if (!hasInlineVectors && !vectorStore) {
        throw new Error('Vector DB has no vector data');
    }
    if (!hasInlineVectors && vectorStore && vectorStore.dimensions !== dimensions) {
        throw new Error('Vector DB has dimension mismatch between vectors and metadata');
    }
    if (hasInlineVectors && chunks.some((chunk) => !chunk.vector || chunk.vector.length !== dimensions)) {
        throw new Error('Vector DB has dimension mismatch');
    }
    const postings = normalizePostings(payload?.postings);

    const metadataUrl = indexUrl;
    const vectorStoreUrl = vectorStore ? resolveVectorUrl(metadataUrl, vectorStore.file) : undefined;
    const statsPayload = payload?.stats && typeof payload.stats === 'object'
        ? payload.stats as Record<string, unknown>
        : {};
    const resolvedDocCount = Number(statsPayload.docCount);
    const resolvedChunkCount = Number(statsPayload.chunkCount);
    const resolvedTokenCount = Number(statsPayload.tokenCount);

    return {
        version: `${payload?.version ?? '0.5.0'}`,
        dimensions,
        metric: 'cosine',
        createdAt: `${payload?.createdAt ?? new Date().toISOString()}`,
        vectorStore: vectorStore,
        hasInlineVectors,
        _metadataUrl: metadataUrl,
        _vectorStoreUrl: vectorStoreUrl,
        _vectorDbPassword: vectorDbPassword,
        bm25,
        postings,
        stats: {
            docCount: Number.isFinite(resolvedDocCount) ? resolvedDocCount : chunksRaw.length,
            chunkCount: Number.isFinite(resolvedChunkCount) ? resolvedChunkCount : chunks.length,
            tokenCount: Number.isFinite(resolvedTokenCount) ? resolvedTokenCount : 0,
        },
        chunks,
    };
}

function textToVector(text: string, dim: number): number[] {
    const tokens = tokenize(text);
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

function safeGetTokens(getter: { get_tokens: (text: string) => string[] }, text: string): string[] {
    try {
        return getter.get_tokens(text);
    } catch {
        return tokenize(text);
    }
}

function collectQueryTokens(rawTokens: string[]): string[] {
    const normalized = rawTokens.map((token) => `${token}`.toLowerCase().trim()).filter(Boolean);
    return Array.from(new Set(normalized));
}

function collectCandidateChunkIndices(
    index: VectorSearchIndex,
    queryTokens: string[],
    fallbackLimit: number,
): number[] | null {
    if (!index.postings || !queryTokens.length) return null;

    const candidateSet = new Set<number>();
    for (const token of queryTokens) {
        const ids = index.postings[token];
        if (!ids?.length) continue;
        for (const id of ids) {
            if (Number.isFinite(id) && Number.isInteger(id) && id >= 0) {
                candidateSet.add(id);
            }
        }
    }

    if (!candidateSet.size) return null;

    const candidates = Array.from(candidateSet);
    if (candidates.length <= MAX_CANDIDATE_CHUNKS) {
        return candidates;
    }

    const ranked = candidates.map((chunkIndex) => {
        const chunk = index.chunks[chunkIndex];
        const chunkTerms = chunk?.terms;

        let overlap = 0;
        if (chunkTerms?.length) {
            const termSet = new Set(chunkTerms.map((token) => token.toLowerCase()));
            for (const token of queryTokens) {
                if (termSet.has(token)) {
                    overlap += 1;
                }
            }
        }

        return { chunkIndex, overlap };
    });

    ranked.sort((a, b) => {
        if (a.overlap !== b.overlap) return b.overlap - a.overlap;
        return a.chunkIndex - b.chunkIndex;
    });

    return ranked.slice(0, Math.max(fallbackLimit, MAX_CANDIDATE_CHUNKS)).map((entry) => entry.chunkIndex);
}

function getChunkTerms(chunk: VectorChunk): string[] {
    if (chunk.terms?.length) return chunk.terms;
    if (chunk.text) return tokenize(chunk.text);
    return tokenize(chunk.preview || '');
}

function embedTextWithOptionalWeights(
    engine: WasmEmbedder,
    text: string,
    useWeighted: boolean,
    weights: number[] | null,
): number[] {
    if (useWeighted && !weights) {
        throw new Error('Weighted embedding requires BM25 weights');
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            return Array.from(engine.embed_batch([text], true, useWeighted ? [weights] : null));
        } catch (error) {
            if (!useWeighted || attempt > 0) {
                throw error;
            }
        }
    }

    throw new Error('Failed to embed text with weighted pooling after retry');
}

/**
 * Calculates BM25 weights for a list of tokens based on corpus statistics.
 * These weights are used for weighted pooling in the embedding process.
 */
export function calculateBM25Weights(tokens: string[], stats: Bm25Stats): number[] {
    return calculateBM25WeightsFromTokens(tokens, stats);
}

function cosine(a: number[], b: VectorAccessor): number {
    const len = Math.min(a.length, b.length);
    let sum = 0;
    for (let i = 0; i < len; i++) sum += a[i] * b[i];
    return sum;
}

function extractSnippet(text: string, queryTokens: string[], around = 220): string {
    const normalized = text.toLowerCase();
    if (!queryTokens.length) return text.slice(0, around).trim();
    const candidates = queryTokens
        .map(token => normalized.indexOf(token))
        .filter(idx => idx >= 0)
        .sort((a, b) => a - b);

    if (!candidates.length) return text.slice(0, around).trim();

    const first = candidates[0];
    const start = Math.max(0, first - 90);
    const end = Math.min(text.length, first + around);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < text.length ? '…' : '';
    return `${prefix}${text.slice(start, end)}${suffix}`.trim();
}

export function buildContentVectorIndex(input: VectorBuildInput): Promise<VectorSearchIndex> {
    const {
        slugs,
        getDocumentText,
        inferTitle,
        inferPath,
        onProgress,
    } = input;

    // We'll use a local path for the model relative to the public root
    const MODEL_PATH = '/model';

    return (async () => {
        const engine = await getWasmEngine(MODEL_PATH);

        // Fetch pre-built BM25 stats if available to get IDF/avgdl
        const bm25SourceUrl = input.bm25SourceUrl ?? '/vector-db.json';
        let bm25: Bm25Stats | null = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const existingDb = await loadVectorPayload<Record<string, unknown>>(
                    bm25SourceUrl,
                    input.bm25Password,
                );
                bm25 = requireBm25Stats(existingDb?.bm25) as Bm25Stats;
                break;
            } catch (error) {
                if (attempt > 0) {
                    if (error instanceof Error) throw error;
                    throw new Error('Failed to load BM25 statistics required for vector build');
                }
            }
        }
        if (!bm25) {
            throw new Error('Invalid BM25 statistics loaded for vector build');
        }
        engine.set_pooling('weighted-mean');

        const chunks: VectorChunk[] = [];
        let totalTokens = 0;
        const totalDocs = slugs.length;
        let chunkIdSeed = 0;

        for (let index = 0; index < slugs.length; index += 1) {
            const slug = slugs[index];
            const progress = index + 1;
            const percent = Math.round((progress / Math.max(1, totalDocs)) * 100);
            if (onProgress) onProgress(progress, totalDocs, percent);

            const text = await getDocumentText(slug);
            if (!text) continue;

            // Use the same chunking logic as before
            const sectionPlans = buildSectionChunkPlans(text, {
                maxTokensPerChunk: input.maxTokensPerChunk ?? DEFAULT_MAX_TOKENS,
                chunkOverlapTokens: input.chunkOverlapTokens ?? DEFAULT_OVERLAP,
                minTokensPerChunk: input.minTokensPerChunk ?? DEFAULT_MIN_TOKENS,
            });
            const title = inferTitle(slug);
            const path = inferPath(slug);

            for (const sectionPlan of sectionPlans) {
                for (const chunk of sectionPlan.chunks) {
                    const chunkText = chunk.text;
                    const tokens = safeGetTokens(engine, chunkText);
                    if (!tokens.length) {
                        continue;
                    }

                    const weights = calculateBM25Weights(tokens, bm25);
                    if (weights.length !== tokens.length) {
                        throw new Error(`BM25 weight length mismatch while building index for slug=${slug}`);
                    }
                    const uniqueChunkTokens = Array.from(new Set(tokens)).slice(0, 1024);
                    totalTokens += tokens.length;

                    const vector = embedTextWithOptionalWeights(
                        engine,
                        chunkText,
                        true,
                        weights,
                    );

                    const preview = chunkText.length > 240 ? `${chunkText.slice(0, 240)}...` : chunkText;
                    const sectionLabel = chunk.partIndex > 0
                        ? `${sectionPlan.section.section} (p.${chunk.partIndex + 1})`
                        : sectionPlan.section.section;
                    const anchor = chunk.partIndex === 0
                        ? sectionPlan.headingId
                        : `${sectionPlan.headingId}-p${chunk.partIndex + 1}`;

                    chunks.push({
                        id: `${slug}::${chunkIdSeed}`,
                        slug,
                        title,
                        path,
                        section: sectionLabel,
                        sectionPath: sectionPlan.section.sectionPath,
                        anchor,
                        sectionIndex: sectionPlan.section.sectionIndex,
                        source: 'content',
                        terms: uniqueChunkTokens,
                        text: chunkText,
                        preview,
                        vector,
                    });
                    chunkIdSeed += 1;
                }
            }
        }

        if (!chunks.length) {
            throw new Error('No valid chunks found while building vector index');
        }

        return {
            version: '0.5.0',
            dimensions: engine.dim(),
            metric: 'cosine',
            createdAt: new Date().toISOString(),
            hasInlineVectors: true,
            bm25,
            stats: {
                docCount: slugs.length,
                chunkCount: chunks.length,
                tokenCount: totalTokens,
            },
            chunks,
        };
    })();
}

export function searchVectorIndex(
    index: VectorSearchIndex,
    query: string,
    opts: { limit?: number; minScore?: number } = {}
): VectorSearchHit[] {
    // Note: searchVectorIndex should be async to use Wasm correctly
    // We keep this sync version for backward compatibility but it will fail
    // if called directly without being handled.
    throw new Error('Please use searchVectorIndexAsync for weighted search');
}

export async function searchVectorIndexAsync(
    index: VectorSearchIndex,
    query: string,
    opts: { limit?: number; minScore?: number } = {}
): Promise<VectorSearchHit[]> {
    const limit = opts.limit ?? 12;
    const minScore = opts.minScore ?? 0.01;
    if (!index.bm25) {
        throw new Error('Vector index does not include BM25 statistics');
    }
    const bm25 = requireBm25Stats(index.bm25) as Bm25Stats;

    const queryTokens = tokenize(query);
    if (!queryTokens.length || !index.chunks.length) {
        return [];
    }

    const weights = calculateBM25Weights(queryTokens, bm25);
    if (weights.length !== queryTokens.length) {
        throw new Error('BM25 query weight length mismatch');
    }

    const queryVec = weightedVectorFromTokens(queryTokens, weights, index.dimensions);
    if (!queryVec.length) {
        return [];
    }

    const queryTokenList = collectQueryTokens(queryTokens);
    const candidateChunkIndices = collectCandidateChunkIndices(index, queryTokenList, Math.max(limit * 4, 120));
    const candidateList = candidateChunkIndices === null
        ? index.chunks.map((chunk, chunkIndex) => ({ chunk, chunkIndex }))
        : candidateChunkIndices
            .map((chunkIndex) => ({
                chunkIndex,
                chunk: index.chunks[chunkIndex],
            }))
            .filter((entry): entry is { chunkIndex: number; chunk: VectorChunk } => entry.chunk !== undefined);

    if (!candidateList.length) {
        return [];
    }

    const vectorStore = index.hasInlineVectors || !index.vectorStore
        ? null
        : await loadVectorStore(index);

    const ranked: VectorSearchHit[] = [];
    const querySet = new Set(queryTokenList);

    for (const { chunk, chunkIndex } of candidateList) {
        const chunkVector = getChunkVector(index, chunk, chunkIndex, vectorStore?.chunks ?? null);
        if (!chunkVector) continue;

        const score = cosine(queryVec, chunkVector);
        if (score < minScore) continue;

        const chunkText = chunk.text || chunk.preview || '';
        const chunkTerms = getChunkTerms(chunk);
        const chunkTermSet = new Set(chunkTerms.map((term) => term.toLowerCase()));
        const matched = [...querySet].filter(token => chunkTermSet.has(token));
        const snippet = extractSnippet(chunkText, queryTokenList, 220);
        ranked.push({
            slug: chunk.slug,
            title: chunk.title,
            path: chunk.path,
            section: chunk.section,
            sectionPath: chunk.sectionPath,
            anchor: chunk.anchor,
            snippet,
            score,
            matchedTerms: matched,
        });
    }

    return ranked
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(item => ({
            ...item,
            score: Number(item.score.toFixed(6)),
        }));
}

export function inferTitleFromSlug(slug: string): string {
    const node = slug.split('/').pop() ?? slug;
    return node.replace(/^\d+-/, '').replace(/--/g, ' – ').replace(/-/g, ' ');
}

export function inferPathFromSlug(slug: string): string {
    return slug
        .split('/')
        .map(part => part.replace(/^\d+-/, '').replace(/--/g, ' – ').replace(/-/g, ' '))
        .slice(0, -1)
        .join(' / ');
}

export function normalizeChunkSearchText(input: string): string {
    return flattenForSearch(input);
}
