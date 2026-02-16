import { loadPrebuiltVectorIndex, searchVectorIndexAsync, type VectorSearchHit, type VectorSearchIndex } from './rag-vector.js';
import { setWasmModulePath } from './wasm-engine.js';

export interface WebRagOptions {
    indexUrl?: string;
    password?: string;
    wasmModulePath?: string;
    preloadVectorStore?: boolean;
}

export interface WebRagClient {
    search: (query: string, opts?: { limit?: number; minScore?: number }) => Promise<VectorSearchHit[]>;
    getIndex: () => Promise<VectorSearchIndex>;
}

export function createWebRagClient(options: WebRagOptions = {}): WebRagClient {
    const {
        indexUrl = '/vector-db.json',
        password,
        wasmModulePath,
    } = options;

    if (wasmModulePath) {
        setWasmModulePath(wasmModulePath);
    }

    let indexPromise: Promise<VectorSearchIndex> | null = null;

    const getIndex = async (): Promise<VectorSearchIndex> => {
        if (!indexPromise) {
            indexPromise = loadPrebuiltVectorIndex(indexUrl, password);
        }
        return indexPromise;
    };

    return {
        async search(query: string, opts = {}) {
            const index = await getIndex();
            return searchVectorIndexAsync(index, query, opts);
        },
        getIndex,
    };
}
