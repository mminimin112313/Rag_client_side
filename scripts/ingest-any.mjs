#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { slugify, validateDocumentsPayload } from './lib/document-utils.mjs';

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i += 1) {
        const item = argv[i];
        if (!item.startsWith('--')) continue;
        const [key, value] = item.replace(/^--/, '').split('=');
        if (value !== undefined) out[key] = value;
        else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
            out[key] = argv[i + 1];
            i += 1;
        } else {
            out[key] = 'true';
        }
    }
    return out;
}

function listFilesRecursively(root, extensions) {
    const out = [];
    const stack = [root];
    while (stack.length) {
        const current = stack.pop();
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
                continue;
            }
            const ext = path.extname(entry.name).toLowerCase();
            if (extensions.has(ext)) {
                out.push(full);
            }
        }
    }
    return out.sort();
}

function parseCsv(text) {
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return [];
    const headers = lines[0].split(',').map((h) => h.trim());

    const rows = [];
    for (let i = 1; i < lines.length; i += 1) {
        const cols = lines[i].split(',');
        const row = {};
        for (let j = 0; j < headers.length; j += 1) {
            row[headers[j]] = `${cols[j] ?? ''}`.trim();
        }
        rows.push(row);
    }
    return rows;
}

function normalizeFromMdDir(from) {
    const files = listFilesRecursively(from, new Set(['.md', '.markdown']));
    return files.map((file, i) => {
        const rel = path.relative(from, file).replace(/\\/g, '/');
        const base = path.basename(file).replace(/\.(md|markdown)$/i, '');
        const text = fs.readFileSync(file, 'utf-8');
        return {
            id: slugify(rel || `doc-${i + 1}`),
            title: base,
            text,
            path: path.dirname(rel) === '.' ? '' : path.dirname(rel),
        };
    });
}

function normalizeFromTxtDir(from) {
    const files = listFilesRecursively(from, new Set(['.txt']));
    return files.map((file, i) => {
        const rel = path.relative(from, file).replace(/\\/g, '/');
        const base = path.basename(file).replace(/\.txt$/i, '');
        const text = fs.readFileSync(file, 'utf-8');
        return {
            id: slugify(rel || `doc-${i + 1}`),
            title: base,
            text,
            path: path.dirname(rel) === '.' ? '' : path.dirname(rel),
        };
    });
}

function normalizeFromJsonl(from) {
    const lines = fs.readFileSync(from, 'utf-8').split(/\r?\n/).filter(Boolean);
    return lines.map((line, i) => {
        const row = JSON.parse(line);
        return {
            id: `${row.id ?? `doc-${i + 1}`}`,
            title: `${row.title ?? ''}`,
            text: `${row.text ?? ''}`,
            path: `${row.path ?? ''}`,
            tags: Array.isArray(row.tags) ? row.tags : [],
            metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
            updatedAt: `${row.updatedAt ?? ''}`,
        };
    });
}

function normalizeFromCsv(from) {
    const rows = parseCsv(fs.readFileSync(from, 'utf-8'));
    return rows.map((row, i) => ({
        id: `${row.id || `doc-${i + 1}`}`,
        title: `${row.title || ''}`,
        text: `${row.text || ''}`,
        path: `${row.path || ''}`,
        tags: row.tags ? row.tags.split('|').map((tag) => tag.trim()).filter(Boolean) : [],
        metadata: row.metadata ? { raw: row.metadata } : {},
        updatedAt: `${row.updatedAt || ''}`,
    }));
}

function normalizeFromJson(from) {
    const raw = JSON.parse(fs.readFileSync(from, 'utf-8'));
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw.documents)) return raw.documents;
    throw new Error('JSON input must be array or object with `documents`.');
}

function normalizeByType(type, from) {
    const normalizedType = `${type}`.toLowerCase().trim();
    if (normalizedType === 'json') return normalizeFromJson(from);
    if (normalizedType === 'jsonl') return normalizeFromJsonl(from);
    if (normalizedType === 'csv') return normalizeFromCsv(from);
    if (normalizedType === 'md-dir') return normalizeFromMdDir(from);
    if (normalizedType === 'txt-dir') return normalizeFromTxtDir(from);
    throw new Error(`Unsupported input type: ${type}`);
}

function detectType(from) {
    const stat = fs.statSync(from);
    if (stat.isDirectory()) {
        const mdCount = listFilesRecursively(from, new Set(['.md', '.markdown'])).length;
        if (mdCount > 0) return 'md-dir';
        const txtCount = listFilesRecursively(from, new Set(['.txt'])).length;
        if (txtCount > 0) return 'txt-dir';
        throw new Error('Cannot detect directory input type. Use --type md-dir|txt-dir.');
    }

    const ext = path.extname(from).toLowerCase();
    if (ext === '.json') return 'json';
    if (ext === '.jsonl' || ext === '.ndjson') return 'jsonl';
    if (ext === '.csv') return 'csv';
    throw new Error(`Cannot detect file input type for extension: ${ext}`);
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const from = path.resolve(process.cwd(), args.from || args.input || './rag-documents.json');
    const out = path.resolve(process.cwd(), args.out || './rag-documents.json');
    if (!fs.existsSync(from)) throw new Error(`input not found: ${from}`);

    const type = args.type || detectType(from);
    const docs = normalizeByType(type, from);
    const payload = { version: '1.0', documents: docs };

    const validated = validateDocumentsPayload(payload);
    if (!validated.ok) {
        for (const error of validated.errors) {
            console.error(`- ${error}`);
        }
        process.exit(1);
    }

    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify({ version: '1.0', documents: validated.documents }, null, 2)}\n`, 'utf-8');

    console.log(`Ingested ${validated.documents.length} documents.`);
    console.log(`Type: ${type}`);
    console.log(`Output: ${out}`);
}

try {
    main();
} catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
}
