#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { validateDocumentsPayload } from './lib/document-utils.mjs';

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
    return `${input || ''}`.toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-+|-+$/g, '') || 'doc';
}

function parseBoolean(value, fallback = false) {
    if (value === undefined || value === null) return fallback;
    return !['0', 'false', 'off', 'no'].includes(String(value).toLowerCase());
}

function nowMs() {
    return Date.now();
}

function deriveVectorTuning({ args, documents }) {
    const explicitDim = Number.parseInt(args.dim, 10);
    const explicitChunkSize = Number.parseInt(args['chunk-size'], 10);
    const explicitOverlap = Number.parseInt(args['chunk-overlap'], 10);
    const autoTune = parseBoolean(args['auto-tune'], true);
    const totalChars = documents.reduce((sum, d) => sum + d.text.length, 0);
    const docCount = documents.length;

    let dim = Number.isFinite(explicitDim) ? explicitDim : 256;
    let chunkSize = Number.isFinite(explicitChunkSize) ? explicitChunkSize : 220;
    let chunkOverlap = Number.isFinite(explicitOverlap) ? explicitOverlap : 30;

    const tuned = [];
    if (autoTune && !Number.isFinite(explicitDim) && !Number.isFinite(explicitChunkSize)) {
        if (docCount >= 2000 || totalChars >= 20_000_000) {
            dim = 128;
            chunkSize = 320;
            chunkOverlap = 40;
            tuned.push('dim=128');
            tuned.push('chunk-size=320');
            tuned.push('chunk-overlap=40');
        }
        if (docCount >= 10000 || totalChars >= 80_000_000) {
            dim = 96;
            chunkSize = 420;
            chunkOverlap = 60;
            tuned.push('dim=96');
            tuned.push('chunk-size=420');
            tuned.push('chunk-overlap=60');
        }
    }

    return { dim, chunkSize, chunkOverlap, autoTune, tuned };
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const inputPath = path.resolve(process.cwd(), args.input || './rag-documents.json');
    const outputPath = path.resolve(process.cwd(), args.output || './public');
    const mdDirName = args.md || 'markdown';
    const qaDirName = args.qa || 'qa';
    const passwordEnvName = args['password-env'] || 'WIKI_PASSWORD';
    const password = args.password || process.env[passwordEnvName] || '';
    const encryptVectors = parseBoolean(args['encrypt-vectors'], true);
    const encryptContent = parseBoolean(args['encrypt-content'], true);

    if (!fs.existsSync(inputPath)) {
        throw new Error(`input not found: ${inputPath}`);
    }

    const raw = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
    const validated = validateDocumentsPayload(raw);
    if (!validated.ok) {
        for (const error of validated.errors) {
            console.error(`- ${error}`);
        }
        process.exit(1);
    }
    const documents = validated.documents;
    const tuning = deriveVectorTuning({ args, documents });

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-client-docs-'));
    const mdRoot = path.join(tempRoot, mdDirName);
    const qaRoot = path.join(tempRoot, qaDirName);
    fs.mkdirSync(mdRoot, { recursive: true });
    fs.mkdirSync(qaRoot, { recursive: true });

    try {
        const t0 = nowMs();
        for (let i = 0; i < documents.length; i += 1) {
            const doc = documents[i];
            const slug = slugify(doc.id || doc.title || `doc-${i + 1}`);
            const title = doc.title.trim() ? `# ${doc.title.trim()}\n\n` : '';
            const body = `${title}${doc.text.trim()}\n`;
            const filename = `${String(i + 1).padStart(4, '0')}-${slug}.md`;
            fs.writeFileSync(path.join(mdRoot, filename), body, 'utf-8');
        }
        const tMaterialize = nowMs() - t0;

        const env = { ...process.env };
        if (password) env[passwordEnvName] = password;

        const t1 = nowMs();
        run(process.execPath, [
            path.resolve(process.cwd(), 'scripts/encrypt-content.mjs'),
            `--source=${tempRoot}`,
            `--md=${mdDirName}`,
            `--qa=${qaDirName}`,
            `--output=${outputPath}`,
            `--encrypt-content=${encryptContent ? 'true' : 'false'}`,
            `--password-env=${passwordEnvName}`,
            ...(password ? [`--password=${password}`] : []),
        ], env);
        const tContent = nowMs() - t1;

        const t2 = nowMs();
        run(process.execPath, [
            path.resolve(process.cwd(), 'scripts/build-vector-db.mjs'),
            `--source=${tempRoot}`,
            `--md=${mdDirName}`,
            `--output=${outputPath}`,
            '--out=vector-db.json',
            `--dim=${tuning.dim}`,
            `--chunk-size=${tuning.chunkSize}`,
            `--chunk-overlap=${tuning.chunkOverlap}`,
            ...(encryptVectors ? ['--encrypt'] : []),
            `--password-env=${passwordEnvName}`,
            ...(password ? [`--password=${password}`] : []),
        ], env);
        const tVector = nowMs() - t2;

        console.log(`Built RAG assets from ${documents.length} documents.`);
        console.log(`Output: ${outputPath}`);
        console.log(`Content encryption: ${encryptContent ? 'on' : 'off'}`);
        console.log(`Vector encryption: ${encryptVectors ? 'on' : 'off'}`);
        console.log(`Vector params: dim=${tuning.dim}, chunk-size=${tuning.chunkSize}, chunk-overlap=${tuning.chunkOverlap}`);
        if (tuning.tuned.length) {
            console.log(`Auto-tune applied: ${tuning.tuned.join(', ')}`);
        }

        const stages = [
            { name: 'materialize-documents', ms: tMaterialize },
            { name: 'build-content', ms: tContent },
            { name: 'build-vectors', ms: tVector },
        ].sort((a, b) => b.ms - a.ms);
        const total = tMaterialize + tContent + tVector;
        const top = stages[0];
        const ratio = total > 0 ? (top.ms / total) * 100 : 0;
        console.log(`Stage timings(ms): materialize=${tMaterialize}, content=${tContent}, vectors=${tVector}, total=${total}`);
        if (ratio >= 45) {
            console.log(`Bottleneck detected: ${top.name} (${ratio.toFixed(1)}% of total).`);
        }
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
