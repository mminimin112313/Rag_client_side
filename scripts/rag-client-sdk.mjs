#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i += 1) {
        const item = argv[i];
        if (!item.startsWith('--')) {
            out._.push(item);
            continue;
        }

        const [rawKey, rawValue] = item.replace(/^--/, '').split('=');
        if (rawValue !== undefined) {
            out[rawKey] = rawValue;
            continue;
        }

        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
            out[rawKey] = next;
            i += 1;
        } else {
            out[rawKey] = 'true';
        }
    }
    return out;
}

function run(command, args, cwd = process.cwd(), env = process.env) {
    const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: false });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}`);
}

function runTimed(label, command, args, cwd = process.cwd(), env = process.env) {
    const start = Date.now();
    run(command, args, cwd, env);
    return { label, ms: Date.now() - start };
}

function printUsage() {
    console.log(`
rag-client-sdk

Usage:
  node scripts/rag-client-sdk.mjs init [--input ./rag-documents.json]
  node scripts/rag-client-sdk.mjs ingest --from ./raw-input --type json|jsonl|csv|md-dir|txt-dir [--out ./rag-documents.json]
  node scripts/rag-client-sdk.mjs validate [--input ./rag-documents.json]
  node scripts/rag-client-sdk.mjs prepare [--source ./docs] [--md markdown] [--qa qa] [--output ./public] [--password ...] [--password-env WIKI_PASSWORD] [--encrypt-content true|false] [--encrypt-vectors true|false] [--auto-tune true|false] [--dim 256] [--chunk-size 220] [--chunk-overlap 30]
  node scripts/rag-client-sdk.mjs prepare [--input ./rag-documents.json] [--output ./public] [--password ...] [--password-env WIKI_PASSWORD] [--encrypt-content true|false] [--encrypt-vectors true|false] [--auto-tune true|false] [--dim 256] [--chunk-size 220] [--chunk-overlap 30]
  node scripts/rag-client-sdk.mjs build-wasm [--rust-source ../rag-gemma-candle-wasm] [--out ./public/pkg] [--docker true|false]

Examples:
  node scripts/rag-client-sdk.mjs ingest --from ./knowledge.jsonl --type jsonl --out ./rag-documents.json
  WIKI_PASSWORD='secret' node scripts/rag-client-sdk.mjs prepare --input ./rag-documents.json --output ./public
  node scripts/rag-client-sdk.mjs prepare --source ./docs --password secret --encrypt-vectors true
  node scripts/rag-client-sdk.mjs build-wasm --rust-source ../rag-gemma-candle-wasm --out ./public/pkg
`);
}

function toBool(raw, fallback = false) {
    if (raw === undefined || raw === null) return fallback;
    return !['0', 'false', 'off', 'no'].includes(String(raw).toLowerCase());
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const command = args._[0];
    if (!command || command === 'help' || command === '--help' || command === '-h') {
        printUsage();
        return;
    }

    const source = path.resolve(process.cwd(), args.source || './docs');
    const input = path.resolve(process.cwd(), args.input || './rag-documents.json');
    const md = args.md || 'markdown';
    const qa = args.qa || 'qa';
    const output = path.resolve(process.cwd(), args.output || './public');

    if (command === 'init') {
        if (!fs.existsSync(input)) {
            const sample = {
                documents: [
                    {
                        id: 'getting-started',
                        title: 'Getting Started',
                        text: 'Put any plain text here. This SDK will build encrypted content and vector index for browser retrieval.'
                    }
                ]
            };
            fs.writeFileSync(input, `${JSON.stringify(sample, null, 2)}\n`, 'utf-8');
            console.log(`Initialized input: ${input}`);
        } else {
            console.log(`Input already exists: ${input}`);
        }
        return;
    }

    if (command === 'prepare') {
        const passwordEnvName = args['password-env'] || 'WIKI_PASSWORD';
        const password = args.password || process.env[passwordEnvName] || '';
        const env = { ...process.env };
        if (password) {
            env[passwordEnvName] = password;
        }

        const encryptVectors = toBool(args['encrypt-vectors'], true);
        const encryptContent = toBool(args['encrypt-content'], true);
        if (args.input) {
            run(process.execPath, [
                path.resolve('scripts/build-from-documents.mjs'),
                `--input=${input}`,
                `--output=${output}`,
                `--password-env=${passwordEnvName}`,
                `--encrypt-content=${encryptContent ? 'true' : 'false'}`,
                `--encrypt-vectors=${encryptVectors ? 'true' : 'false'}`,
                `--auto-tune=${toBool(args['auto-tune'], true) ? 'true' : 'false'}`,
                ...(args.dim ? [`--dim=${args.dim}`] : []),
                ...(args['chunk-size'] ? [`--chunk-size=${args['chunk-size']}`] : []),
                ...(args['chunk-overlap'] ? [`--chunk-overlap=${args['chunk-overlap']}`] : []),
                ...(password ? [`--password=${password}`] : []),
            ], process.cwd(), env);
        } else {
            const t1 = runTimed('build-content', process.execPath, [
                path.resolve('scripts/encrypt-content.mjs'),
                `--source=${source}`,
                `--md=${md}`,
                `--qa=${qa}`,
                `--output=${output}`,
                `--encrypt-content=${encryptContent ? 'true' : 'false'}`,
                `--password-env=${passwordEnvName}`,
                ...(password ? [`--password=${password}`] : []),
            ], process.cwd(), env);

            const t2 = runTimed('build-vectors', process.execPath, [
                path.resolve('scripts/build-vector-db.mjs'),
                `--source=${source}`,
                `--md=${md}`,
                `--output=${output}`,
                '--out=vector-db.json',
                `--dim=${args.dim || 256}`,
                `--chunk-size=${args['chunk-size'] || 220}`,
                `--chunk-overlap=${args['chunk-overlap'] || 30}`,
                ...(encryptVectors ? ['--encrypt'] : []),
                `--password-env=${passwordEnvName}`,
                ...(password ? [`--password=${password}`] : []),
            ], process.cwd(), env);

            const total = t1.ms + t2.ms;
            const top = t1.ms >= t2.ms ? t1 : t2;
            const ratio = total > 0 ? (top.ms / total) * 100 : 0;
            console.log(`Stage timings(ms): ${t1.label}=${t1.ms}, ${t2.label}=${t2.ms}, total=${total}`);
            if (ratio >= 45) {
                console.log(`Bottleneck detected: ${top.label} (${ratio.toFixed(1)}% of total).`);
            }
        }

        console.log('Prepared encrypted content + vector index.');
        return;
    }

    if (command === 'ingest') {
        const from = path.resolve(process.cwd(), args.from || args.input || './rag-documents.json');
        const out = path.resolve(process.cwd(), args.out || './rag-documents.json');
        run(process.execPath, [
            path.resolve('scripts/ingest-any.mjs'),
            `--from=${from}`,
            ...(args.type ? [`--type=${args.type}`] : []),
            `--out=${out}`,
        ]);
        return;
    }

    if (command === 'validate') {
        run(process.execPath, [
            path.resolve('scripts/validate-documents.mjs'),
            `--input=${input}`,
        ]);
        return;
    }

    if (command === 'build-wasm') {
        const rustSource = path.resolve(process.cwd(), args['rust-source'] || '../rag-gemma-candle-wasm');
        const wasmOut = path.resolve(process.cwd(), args.out || './public/pkg');
        run(process.execPath, [
            path.resolve('scripts/build-wasm.mjs'),
            `--rust-source=${rustSource}`,
            `--out=${wasmOut}`,
            ...(args.docker ? [`--docker=${args.docker}`] : []),
        ]);
        return;
    }

    throw new Error(`Unknown command: ${command}`);
}

try {
    main();
} catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
}
