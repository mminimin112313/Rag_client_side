import { useMemo } from 'react';
import {
  decryptPayloadToJson,
  loadPrebuiltVectorIndex,
  searchVectorIndexAsync,
  type VectorSearchHit,
  type VectorSearchIndex,
} from '@mminimin112313/rag-client-side';

async function loadIndex(password: string): Promise<VectorSearchIndex> {
  const indexResponse = await fetch('/vector-db.json');
  const indexPayload = await indexResponse.json();

  if (indexPayload?.salt && indexPayload?.iv && indexPayload?.ciphertext) {
    return decryptPayloadToJson<VectorSearchIndex>(password, indexPayload);
  }

  return loadPrebuiltVectorIndex('/vector-db.json');
}

export function useRagSearch(password: string) {
  const api = useMemo(() => {
    let cached: Promise<VectorSearchIndex> | null = null;

    const ensureIndex = () => {
      if (!cached) cached = loadIndex(password);
      return cached;
    };

    return {
      async search(query: string, limit = 10): Promise<VectorSearchHit[]> {
        const index = await ensureIndex();
        return searchVectorIndexAsync(index, query, { limit, minScore: 0.01 });
      },
    };
  }, [password]);

  return api;
}
