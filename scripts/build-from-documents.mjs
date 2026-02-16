#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i += 1) {
        const item = argv[i];
        if (!item.startsWith('--')) continue;

        const [k, v] = item.replace(/^--/, '').split('=');
        if (v !== undefined) {
            out[k] = v;
            continue;
        }

        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
            out[k] = next;
            i += 1;
        } else {
            out[k] = 'true';
        }
    }
    return out;
}

function run(command, args, env) {
    const r = spawnSync(command, args, { stdio: 'inherit', shell: false, env });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`${command} exited with code ${r.status}`);
}

function slugify(input) {
    return `${input || ''}`
        .toLowerCase()
        .replace(/[^a-z0-9가-힣]+/g, '-')
        .replace(/^-+|-+$/g, '')
        || 'doc';
}

function normalizeDocuments(raw) {
    const docs = Array.isArray(raw) ? raw : (Array.isArray(raw?.documents) ? raw.documents : []);
    return docs
        .map((item, i) => ({
            id: `${item?.id ?? i + 1}`,
            title: `${item?.title ?? `Document ${i + 1}`}`,
            text: `${item?.text ?? ''}`,
        }))
        .filter((item) => item.text.trim().length > 0);
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const inputPath = path.resolve(process.cwd(), args.input || './rag-documents.json');
    const outputPath = path.resolve(process.cwd(), args.output || './public');
    const mdDirName = args.md || 'markdown';
    const qaDirName = args.qa || 'qa';
    const passwordEnvName = args['password-env'] || 'WIKI_PASSWORD';
    const password = args.password || process.env[passwordEnvName] || '';
    const encryptVectors = !['0', 'false', 'off', 'no'].includes(`${args['encrypt-vectors'] ?? 'true'}`.toLowerCase());

    if (!fs.existsSync(inputPath)) {
        throw new Error(`input not found: ${inputPath}`);
    }

    const raw = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
    const documents = normalizeDocuments(raw);
    if (!documents.length) {
        throw new Error('No documents found in input. Expected array or { documents: [] }.');
    }

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-client-docs-'));
    const mdRoot = path.join(tempRoot, mdDirName);
    const qaRoot = path.join(tempRoot, qaDirName);
    fs.mkdirSync(mdRoot, { recursive: true });
    fs.mkdirSync(qaRoot, { recursive: true });

    try {
        for (let i = 0; i < documents.length; i += 1) {
            const doc = documents[i];
            const slug = slugify(doc.id || doc.title || `doc-${i + 1}`);
            const title = doc.title.trim() ? `# ${doc.title.trim()}\n\n` : '';
            const body = `${title}${doc.text.trim()}\n`;
            const filename = `${String(i + 1).padStart(4, '0')}-${slug}.md`;
            fs.writeFileSync(path.join(mdRoot, filename), body, 'utf-8');
        }

        const env = { ...process.env };
        if (password) env[passwordEnvName] = password;

        run(process.execPath, [
            path.resolve(process.cwd(), 'scripts/encrypt-content.mjs'),
            `--source=${tempRoot}`,
            `--md=${mdDirName}`,
            `--qa=${qaDirName}`,
            `--output=${outputPath}`,
            `--password-env=${passwordEnvName}`,
            ...(password ? [`--password=${password}`] : []),
        ], env);

        run(process.execPath, [
            path.resolve(process.cwd(), 'scripts/build-vector-db.mjs'),
            `--source=${tempRoot}`,
            `--md=${mdDirName}`,
            `--output=${outputPath}`,
            '--out=vector-db.json',
            '--dim=256',
            '--chunk-size=220',
            '--chunk-overlap=30',
            ...(encryptVectors ? ['--encrypt'] : []),
            `--password-env=${passwordEnvName}`,
            ...(password ? [`--password=${password}`] : []),
        ], env);

        console.log(`Built RAG assets from ${documents.length} documents.`);
        console.log(`Output: ${outputPath}`);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

try {
    main();
} catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
}
