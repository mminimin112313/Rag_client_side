import fs from 'node:fs';

export function slugify(input) {
    return `${input || ''}`
        .toLowerCase()
        .replace(/[^a-z0-9가-힣]+/g, '-')
        .replace(/^-+|-+$/g, '')
        || 'doc';
}

export function normalizeDocuments(raw) {
    const docs = Array.isArray(raw) ? raw : (Array.isArray(raw?.documents) ? raw.documents : []);
    return docs.map((item, i) => ({
        id: `${item?.id ?? `doc-${i + 1}`}`.trim(),
        title: `${item?.title ?? ''}`.trim(),
        text: `${item?.text ?? ''}`,
        path: `${item?.path ?? ''}`.trim(),
        tags: Array.isArray(item?.tags) ? item.tags.map((tag) => `${tag}`).filter(Boolean) : [],
        metadata: item?.metadata && typeof item.metadata === 'object' ? item.metadata : {},
        updatedAt: `${item?.updatedAt ?? ''}`.trim(),
    })).filter((doc) => doc.text.trim().length > 0);
}

export function validateDocumentsPayload(raw) {
    const errors = [];

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        errors.push('Root must be an object with `documents` array.');
        return { ok: false, errors, documents: [] };
    }

    if (!Array.isArray(raw.documents)) {
        errors.push('`documents` must be an array.');
        return { ok: false, errors, documents: [] };
    }

    const normalized = normalizeDocuments(raw);
    if (!normalized.length) {
        errors.push('No valid documents found after normalization.');
        return { ok: false, errors, documents: [] };
    }

    const seen = new Set();
    for (let i = 0; i < normalized.length; i += 1) {
        const doc = normalized[i];
        if (!doc.id) errors.push(`documents[${i}].id is required.`);
        if (!doc.text.trim()) errors.push(`documents[${i}].text must be non-empty.`);
        if (seen.has(doc.id)) errors.push(`Duplicate document id: ${doc.id}`);
        seen.add(doc.id);
    }

    return {
        ok: errors.length === 0,
        errors,
        documents: normalized,
    };
}

export function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}
