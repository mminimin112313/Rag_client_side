/** @typedef {{ avgdl: number, idf: Record<string, number>, N: number }} Bm25Stats */

function parseFiniteNumber(value: unknown): number | null {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function cleanIdfMap(raw: unknown): Record<string, number> | null {
    if (!raw || typeof raw !== 'object') return null;

    const cleaned: Record<string, number> = {};
    for (const [token, rawValue] of Object.entries(raw)) {
        const value = parseFiniteNumber(rawValue);
        if (!token || value === null) continue;
        cleaned[token] = value;
    }

    return Object.keys(cleaned).length ? cleaned : null;
}

export function normalizeBm25Stats(raw: unknown): { avgdl: number; idf: Record<string, number>; N: number } | null {
    if (!raw || typeof raw !== 'object') return null;

    const avgdl = parseFiniteNumber((raw as { avgdl?: unknown }).avgdl);
    if (avgdl === null || avgdl <= 0) return null;

    const idf = cleanIdfMap((raw as { idf?: unknown }).idf);
    if (!idf) return null;

    const N = parseFiniteNumber((raw as { N?: unknown }).N);
    if (N === null || N <= 0) return null;
    return { avgdl, idf, N };
}

export function requireBm25Stats(raw: unknown): { avgdl: number; idf: Record<string, number>; N: number } {
    const stats = normalizeBm25Stats(raw);
    if (!stats) {
        throw new Error('Invalid BM25 statistics payload');
    }
    return stats;
}

function buildDefaultIdf(idf: Record<string, number>): number {
    const values = Object.values(idf).filter((value) => Number.isFinite(value));
    if (!values.length) return 1;

    let sum = 0;
    for (const value of values) sum += value;
    const mean = sum / values.length;
    if (Number.isFinite(mean) && mean > 0) return mean;
    return 1;
}

export function calculateBM25WeightsFromTokens(tokens: string[], stats: { avgdl: number; idf: Record<string, number> }): number[] {
    if (!Array.isArray(tokens)) throw new Error('tokens must be an array');
    if (!stats || typeof stats !== 'object') throw new Error('bm25 stats missing');

    const normalized = tokens.map((token) => `${token}`.toLowerCase().trim()).filter(Boolean);
    if (!normalized.length) return [];

    const idf = stats.idf || {};
    const fallbackIdf = buildDefaultIdf(idf);

    const counts: Record<string, number> = {};
    for (const token of normalized) {
        counts[token] = (counts[token] || 0) + 1;
    }

    const k1 = 1.2;
    const b = 0.75;
    const denominatorBase = k1 * (1 - b + b * (normalized.length / (stats.avgdl || 1)));

    return normalized.map((token) => {
        const docFreq = counts[token] || 0;
        const tokenIdf = Number.isFinite(Number(idf[token])) ? Number(idf[token]) : fallbackIdf;
        const score = tokenIdf * ((docFreq * (k1 + 1)) / (docFreq + denominatorBase));
        return Number.isFinite(score) ? score : 0;
    });
}
