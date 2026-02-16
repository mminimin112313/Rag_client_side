# Rag Client Side SDK

Browser-first RAG SDK that can be attached to any frontend application and also reused in local app runtimes.

## What This SDK Includes

- Client-side encrypted content loading and decryption (`content.enc.json`, page-wise encrypted files)
- BM25-weighted retrieval with vector search
- Optional Rust WASM embedder (`rag_embedding_wasm.js`) with automatic JS fallback
- Data preparation pipeline from markdown/qa to deployable assets

## Install

```bash
npm install
npm run build
```

## Data Pipeline (Any App)

Prepare input:

- `docs/markdown/**/*.md`
- `docs/qa/**/*.json`

Build encrypted dataset + vector index:

```bash
WIKI_PASSWORD='your-password' node scripts/rag-client-sdk.mjs prepare \
  --source ./docs \
  --md markdown \
  --qa qa \
  --output ./public
```

Generated outputs:

- `public/content.enc.json`
- `public/content/pages/*.enc.json`
- `public/vector-db.json`
- `public/vector-db-vectors.bin.enc` (when `--encrypt-vectors true`, default)

## Runtime Usage (Frontend)

```ts
import { decryptPayloadToJson, searchVectorIndexAsync, type VectorSearchIndex } from '@mminimin112313/rag-client-side';

async function runSearch(password: string, query: string) {
  const res = await fetch('/vector-db.json');
  const payload = await res.json();

  let index = payload as VectorSearchIndex;
  if (payload?.salt && payload?.iv && payload?.ciphertext) {
    index = await decryptPayloadToJson<VectorSearchIndex>(password, payload);
  }

  return searchVectorIndexAsync(index, query, { limit: 10, minScore: 0.01 });
}
```

## WASM vs Non-WASM

Default behavior:

- Tries to load `/pkg/rag_embedding_wasm.js`
- If not found, falls back to JS hashing embedder automatically

If your app hosts WASM in a custom path:

```ts
import { setWasmModulePath } from '@mminimin112313/rag-client-side';

setWasmModulePath('/assets/wasm/rag_embedding_wasm.js');
```

## API Surface

Main exports:

- `decryptPayload`, `decryptPayloadToJson`, `decryptPayloadBytes`
- `calculateBM25WeightsFromTokens`, `requireBm25Stats`
- `loadPrebuiltVectorIndex`, `searchVectorIndexAsync`
- `buildContentNavigationPlan`, `normalizeContentForChunking`
- `setWasmModulePath`, `getWasmEngine`, `initWasmEngine`

## Local App / Electron / Tauri Notes

- This SDK is pure TypeScript ESM at runtime output (`dist`) and can run in browser-like contexts.
- For desktop wrappers (Electron/Tauri), serve generated assets from local static path and call the same SDK APIs.
- Keep encryption password in runtime input flow, not hardcoded.

## Quick Start Commands

```bash
# 1) initialize docs skeleton
node scripts/rag-client-sdk.mjs init --source ./docs --md markdown --qa qa

# 2) prepare encrypted deploy assets
WIKI_PASSWORD='your-password' node scripts/rag-client-sdk.mjs prepare --source ./docs --output ./public

# 3) compile sdk package
npm run build
```
