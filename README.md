# Rag Client Side SDK

Any-application client-side RAG SDK.

You can attach this to web apps, desktop wrappers, and local frontends without server-side vector DB.

## Core Goal

- Input your own documents.
- Build encrypted RAG assets.
- Mount search to frontend with one client object.

## 1) Prepare Documents

Create `rag-documents.json`:

```json
{
  "documents": [
    {
      "id": "refund-policy",
      "title": "Refund Policy",
      "text": "Customers can request refund within 7 days ..."
    },
    {
      "id": "shipping",
      "title": "Shipping Guide",
      "text": "Domestic shipping takes 2-3 business days ..."
    }
  ]
}
```

Or initialize a sample:

```bash
node scripts/rag-client-sdk.mjs init --input ./rag-documents.json
```

## 2) Build RAG Assets

```bash
WIKI_PASSWORD='your-password' node scripts/rag-client-sdk.mjs prepare \
  --input ./rag-documents.json \
  --output ./public
```

Outputs:

- `public/content.enc.json`
- `public/content/pages/*.enc.json`
- `public/vector-db.json`
- `public/vector-db-vectors.bin.enc`

## 3) Mount on Frontend

```ts
import { createWebRagClient } from '@mminimin112313/rag-client-side';

const rag = createWebRagClient({
  indexUrl: '/vector-db.json',
  password: userInputPassword,
  wasmModulePath: '/pkg/rag_embedding_wasm.js',
});

const hits = await rag.search('refund deadline', { limit: 8, minScore: 0.01 });
```

## WASM Optional

- If WASM exists, SDK uses it.
- If WASM is missing, SDK automatically falls back to JS embedder.

## Works Across App Types

- Next.js, React, Vue, Svelte web apps
- Electron/Tauri desktop apps (serve same `public` assets locally)
- Any browser runtime with `fetch + WebCrypto`

## CLI Summary

```bash
# sample input
node scripts/rag-client-sdk.mjs init --input ./rag-documents.json

# build from documents.json
WIKI_PASSWORD='your-password' node scripts/rag-client-sdk.mjs prepare --input ./rag-documents.json --output ./public

# legacy path (markdown folders)
WIKI_PASSWORD='your-password' node scripts/rag-client-sdk.mjs prepare --source ./docs --md markdown --qa qa --output ./public
```

## Exports

- `createWebRagClient`
- `loadPrebuiltVectorIndex`, `searchVectorIndexAsync`
- `decryptPayload`, `decryptPayloadToJson`, `decryptPayloadBytes`
- `setWasmModulePath`, `getWasmEngine`, `initWasmEngine`
- `calculateBM25WeightsFromTokens`, `requireBm25Stats`
