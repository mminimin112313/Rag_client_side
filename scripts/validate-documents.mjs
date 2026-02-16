#!/usr/bin/env node

import path from 'node:path';
import { readJson, validateDocumentsPayload } from './lib/document-utils.mjs';

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

function main() {
    const args = parseArgs(process.argv.slice(2));
    const input = path.resolve(process.cwd(), args.input || './rag-documents.json');
    const payload = readJson(input);
    const result = validateDocumentsPayload(payload);

    if (!result.ok) {
        for (const error of result.errors) {
            console.error(`- ${error}`);
        }
        process.exit(1);
    }

    console.log(`Valid: ${result.documents.length} documents (${input})`);
}

main();
