# Rag Client Side SDK

Universal client-side RAG SDK for web and local frontend apps.

It supports:

- documents-first ingestion from any pipeline
- encrypted asset build (`content.enc.json`, vector index)
- optional Rust WASM acceleration with JS fallback

## Canonical Input Spec (`rag-documents.json`)

Schema file:

- `schemas/rag-documents.schema.json`

Canonical format:

```json
{
  "version": "1.0",
  "documents": [
    {
      "id": "unique-id",
      "title": "Display title",
      "text": "Main body text for retrieval",
      "path": "optional/group/path",
      "tags": ["optional", "labels"],
      "metadata": {
        "source": "crm"
      },
      "updatedAt": "2026-02-16T00:00:00Z"
    }
  ]
}
```

Required fields per document:

- `id` (string)
- `text` (non-empty string)

## Any Pipeline -> Canonical Documents

Ingest supported sources:

- `json` (array or `{ documents: [] }`)
- `jsonl`
- `csv` (`id,title,text,path,tags,metadata,updatedAt`)
- `md-dir` (recursive markdown folder)
- `txt-dir` (recursive text folder)

Build canonical `rag-documents.json`:

```bash
node scripts/rag-client-sdk.mjs ingest --from ./knowledge.jsonl --type jsonl --out ./rag-documents.json
node scripts/rag-client-sdk.mjs ingest --from ./docs --type md-dir --out ./rag-documents.json
```

Validate canonical file:

```bash
node scripts/rag-client-sdk.mjs validate --input ./rag-documents.json
```

## Build RAG Assets

```bash
WIKI_PASSWORD='your-password' node scripts/rag-client-sdk.mjs prepare \
  --input ./rag-documents.json \
  --output ./public
```

Output files:

- `public/content.enc.json`
- `public/content/pages/*.enc.json`
- `public/vector-db.json`
- `public/vector-db-vectors.bin.enc`

## Frontend Runtime

```ts
import { createWebRagClient } from '@mminimin112313/rag-client-side';

const rag = createWebRagClient({
  indexUrl: '/vector-db.json',
  password: userInputPassword,
  wasmModulePath: '/pkg/rag_embedding_wasm.js'
});

const hits = await rag.search('refund deadline', { limit: 8, minScore: 0.01 });
```

## Rust WASM Build (Portable)

Build from Rust source repo:

```bash
node scripts/rag-client-sdk.mjs build-wasm \
  --rust-source ../rag-gemma-candle-wasm \
  --out ./public/pkg
```

Docker fallback (if local `wasm-pack` is unavailable):

```bash
node scripts/rag-client-sdk.mjs build-wasm \
  --rust-source ../rag-gemma-candle-wasm \
  --out ./public/pkg \
  --docker true
```

Runtime behavior:

- WASM package present: uses Rust wasm embedder
- WASM package absent: automatic JS fallback

## SDK Commands

```bash
node scripts/rag-client-sdk.mjs init --input ./rag-documents.json
node scripts/rag-client-sdk.mjs ingest --from ./raw --type jsonl --out ./rag-documents.json
node scripts/rag-client-sdk.mjs validate --input ./rag-documents.json
WIKI_PASSWORD='secret' node scripts/rag-client-sdk.mjs prepare --input ./rag-documents.json --output ./public
node scripts/rag-client-sdk.mjs build-wasm --rust-source ../rag-gemma-candle-wasm --out ./public/pkg
```

## Main Exports

- `createWebRagClient`
- `loadPrebuiltVectorIndex`, `searchVectorIndexAsync`
- `decryptPayload`, `decryptPayloadToJson`, `decryptPayloadBytes`
- `setWasmModulePath`, `getWasmEngine`, `initWasmEngine`
- `calculateBM25WeightsFromTokens`, `requireBm25Stats`
