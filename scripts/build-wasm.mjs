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

function run(command, args, cwd = process.cwd()) {
    const r = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`${command} exited with code ${r.status}`);
}

function commandExists(command) {
    const r = spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' });
    return r.status === 0;
}

function copyDir(src, dst) {
    fs.rmSync(dst, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const rustSource = path.resolve(process.cwd(), args['rust-source'] || '../rag-gemma-candle-wasm');
    const crateDir = path.join(rustSource, 'crates', 'rag-embedding-wasm');
    const outDir = path.resolve(process.cwd(), args.out || './public/pkg');
    const useDocker = ['1', 'true', 'yes', 'on'].includes(`${args.docker || 'false'}`.toLowerCase());

    if (!fs.existsSync(crateDir)) {
        throw new Error(`Rust crate not found: ${crateDir}`);
    }

    const tempOut = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-wasm-build-'));
    try {
        if (useDocker) {
            if (!commandExists('docker')) throw new Error('docker is required for --docker mode');

            run('docker', [
                'run', '--rm',
                '-v', `${rustSource}:/work`,
                '-v', `${tempOut}:/out`,
                'rustwasm/wasm-pack:latest',
                'wasm-pack', 'build', '/work/crates/rag-embedding-wasm',
                '--target', 'web',
                '--release',
                '--out-dir', '/out',
                '--out-name', 'rag_embedding_wasm',
            ]);
        } else {
            if (!commandExists('wasm-pack')) {
                throw new Error('wasm-pack not found. Install it or run with --docker true.');
            }

            run('wasm-pack', [
                'build',
                crateDir,
                '--target', 'web',
                '--release',
                '--out-dir', tempOut,
                '--out-name', 'rag_embedding_wasm',
            ]);
        }

        copyDir(tempOut, outDir);
        console.log(`WASM package built.`);
        console.log(`Source: ${crateDir}`);
        console.log(`Output: ${outDir}`);
    } finally {
        fs.rmSync(tempOut, { recursive: true, force: true });
    }
}

try {
    main();
} catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
}
