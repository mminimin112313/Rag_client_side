interface WasmEmbeddingEngineLike {
    set_pooling: (mode: string) => void;
    embed_batch: (texts: string[], normalize: boolean, weights: unknown) => Float32Array;
    dim: () => number;
    get_tokens: (text: string) => string[];
}

interface WasmPipelineLike {
    close?: () => void;
}

interface WasmBundleLike {
    init: () => Promise<void> | void;
    WasmEmbeddingEngine?: new (modelPath: string) => WasmEmbeddingEngineLike;
    WasmRagPipeline?: new (modelPath: string, metric: string) => WasmPipelineLike;
}

const WORD_RE = /[가-힣a-z0-9]+/giu;
const FALLBACK_DIMENSION = 256;

let initialized = false;
let initPromise: Promise<void> | null = null;
let engine: WasmEmbeddingEngineLike | null = null;
let pipeline: WasmPipelineLike | null = null;
let wasLoadedAsJsFallback = false;
let moduleLoadError: Error | null = null;
let wasmModulePath = '/pkg/rag_embedding_wasm.js';

export function setWasmModulePath(pathLike: string): void {
    const next = `${pathLike || ''}`.trim();
    if (!next) return;

    wasmModulePath = next;
    initialized = false;
    initPromise = null;
    engine = null;
    pipeline = null;
    wasLoadedAsJsFallback = false;
    moduleLoadError = null;
}

function tokenizeText(input: string): string[] {
    return (input.match(WORD_RE) || []).map((value) => value.trim().toLowerCase()).filter(Boolean);
}

function stableHash32(input: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

function normalizeVector(values: Float32Array): Float32Array {
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) {
        sum += values[i] * values[i];
    }
    const norm = Math.sqrt(sum) || 1;
    for (let i = 0; i < values.length; i += 1) {
        values[i] /= norm;
    }
    return values;
}

function buildFallbackEngine(dim = FALLBACK_DIMENSION): WasmEmbeddingEngineLike {
    let pooling = 'mean';
    return {
        set_pooling(mode: string) {
            pooling = `${mode}`;
        },
        dim: () => dim,
        get_tokens: tokenizeText,
        embed_batch(texts: string[], _normalize: boolean, weights: unknown) {
            const requested = Number.isFinite((weights as { length?: number })?.length) ? (weights as number[]) : null;
            const output = new Float32Array((texts?.length || 0) * dim);

            for (let textIndex = 0; textIndex < (texts?.length || 0); textIndex += 1) {
                const text = `${texts[textIndex] ?? ''}`;
                const tokens = tokenizeText(text);
                const vec = new Float32Array(dim);
                for (let i = 0; i < tokens.length; i += 1) {
                    const token = tokens[i];
                    const raw = requested?.[i];
                    const weight = Number.isFinite(raw as number) ? Number(raw) : 1;
                    if (!Number.isFinite(weight)) continue;
                    const index = stableHash32(token) % dim;
                    const sign = (stableHash32(`${token}#${pooling}`) & 1) === 0 ? 1 : -1;
                    vec[index] += weight * sign;
                }
                normalizeVector(vec);
                const offset = textIndex * dim;
                output.set(vec, offset);
            }

            if ((texts?.length || 0) <= 1) {
                return new Float32Array(output.slice(0, dim));
            }

            return output;
        },
    };
}

function isPromise(value: unknown): value is PromiseLike<void> {
    return !!value && typeof value === 'object' && typeof (value as PromiseLike<void>).then === 'function';
}

async function loadWasmModule(): Promise<WasmBundleLike | null> {
    if (wasLoadedAsJsFallback) return null;
    if (typeof window === 'undefined') {
        moduleLoadError = new Error('WASM is only available in browser runtime.');
        return null;
    }

    try {
        return (await import(wasmModulePath)) as WasmBundleLike;
    } catch (error) {
        moduleLoadError = error instanceof Error ? error : new Error(String(error));
        return null;
    }
}

export async function initWasmEngine() {
    if (initialized) return;
    if (!initPromise) {
        initPromise = (async () => {
            const wasm = await loadWasmModule();
            if (!wasm) {
                wasLoadedAsJsFallback = true;
                initialized = true;
                return;
            }

            if (!wasm.WasmEmbeddingEngine || !wasm.WasmRagPipeline || !wasm.init) {
                wasLoadedAsJsFallback = true;
                initialized = true;
                return;
            }

            const initResult = wasm.init();
            if (isPromise(initResult)) {
                await initResult;
            }
            initialized = true;
            wasLoadedAsJsFallback = false;
            return;
        })();
    }
    await initPromise;
}

export async function getWasmPipeline(modelPath: string, metric: string = 'cosine'): Promise<WasmPipelineLike | null> {
    await initWasmEngine();
    if (pipeline) {
        return pipeline;
    }

    if (wasLoadedAsJsFallback) return null;

    const wasm = await loadWasmModule();
    if (!wasm || !wasm.WasmRagPipeline) {
        wasLoadedAsJsFallback = true;
        return null;
    }

    pipeline = new wasm.WasmRagPipeline(modelPath, metric);
    return pipeline;
}

export async function getWasmEngine(modelPath: string): Promise<WasmEmbeddingEngineLike> {
    await initWasmEngine();
    if (engine) return engine;

    if (wasLoadedAsJsFallback) {
        if (moduleLoadError) {
            console.warn(`WASM unavailable (${moduleLoadError.message}). Using JS fallback engine.`);
        } else {
            console.warn('WASM package not found. Using JS fallback engine.');
        }
        engine = buildFallbackEngine();
        return engine;
    }

    const wasm = await loadWasmModule();
    if (!wasm || !wasm.WasmEmbeddingEngine) {
        wasLoadedAsJsFallback = true;
        engine = buildFallbackEngine();
        return engine;
    }

    engine = new wasm.WasmEmbeddingEngine(modelPath);
    return engine;
}
