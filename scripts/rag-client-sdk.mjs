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

function printUsage() {
    console.log(`
rag-client-sdk

Usage:
  node scripts/rag-client-sdk.mjs init [--source ./docs] [--md markdown] [--qa qa]
  node scripts/rag-client-sdk.mjs prepare [--source ./docs] [--md markdown] [--qa qa] [--output ./public] [--password ...] [--password-env WIKI_PASSWORD] [--encrypt-vectors true|false]

Examples:
  WIKI_PASSWORD='secret' node scripts/rag-client-sdk.mjs prepare --source ./docs --output ./public
  node scripts/rag-client-sdk.mjs prepare --source ./docs --password secret --encrypt-vectors true
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
    const md = args.md || 'markdown';
    const qa = args.qa || 'qa';
    const output = path.resolve(process.cwd(), args.output || './public');

    if (command === 'init') {
        fs.mkdirSync(path.join(source, md), { recursive: true });
        fs.mkdirSync(path.join(source, qa), { recursive: true });
        console.log(`Initialized source root: ${source}`);
        console.log(`Markdown: ${path.join(source, md)}`);
        console.log(`QA: ${path.join(source, qa)}`);
        return;
    }

    if (command === 'prepare') {
        const passwordEnvName = args['password-env'] || 'WIKI_PASSWORD';
        const password = args.password || process.env[passwordEnvName] || '';
        const env = { ...process.env };
        if (password) {
            env[passwordEnvName] = password;
        }

        run(process.execPath, [
            path.resolve('scripts/encrypt-content.mjs'),
            `--source=${source}`,
            `--md=${md}`,
            `--qa=${qa}`,
            `--output=${output}`,
            `--password-env=${passwordEnvName}`,
            ...(password ? [`--password=${password}`] : []),
        ], process.cwd(), env);

        const encryptVectors = toBool(args['encrypt-vectors'], true);
        run(process.execPath, [
            path.resolve('scripts/build-vector-db.mjs'),
            `--source=${source}`,
            `--md=${md}`,
            `--output=${output}`,
            '--out=vector-db.json',
            '--dim=256',
            '--chunk-size=220',
            '--chunk-overlap=30',
            ...(encryptVectors ? ['--encrypt'] : []),
            `--password-env=${passwordEnvName}`,
            ...(password ? [`--password=${password}`] : []),
        ], process.cwd(), env);

        console.log('Prepared encrypted content + vector index.');
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
