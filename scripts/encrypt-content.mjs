#!/usr/bin/env node
/**
 * encrypt-content.mjs
 * Build-time encryption of all markdown + QA files.
 * Usage:
 *   node scripts/encrypt-content.mjs [--source=/path/to/source-folder] [--output=./next-legal-wiki/public] [--md=markdown] [--qa=qa] [--password-env=WIKI_PASSWORD]
 *   node scripts/encrypt-content.mjs [--source=/path/to/source-folder] [--password=YOUR_PASSWORD] (CI 테스트용)
 * Prompts for password interactively (never stored in code).
 */

import fs from 'fs';
import path from 'path';
import { createInterface } from 'readline';
import { webcrypto } from 'crypto';

function parseArgs(argv) {
    const map = {};
    for (let i = 0; i < argv.length; i++) {
        const item = argv[i];
        if (!item.startsWith('--')) continue;
        const [rawKey, rawValue] = item.replace(/^--/, '').split('=');
        if (rawValue !== undefined) {
            map[rawKey] = rawValue;
            continue;
        }
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
            map[rawKey] = next;
            i += 1;
        }
    }
    return map;
}

const args = parseArgs(process.argv.slice(2));

function parseBoolean(value, fallback = true) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    return !['0', 'false', 'off', 'no'].includes(String(value).toLowerCase().trim());
}

function dirExists(target) {
    return fs.existsSync(target) && fs.statSync(target).isDirectory();
}

function hasMarkdownInDir(target) {
    if (!dirExists(target)) return false;

    const entries = fs.readdirSync(target, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.md')) return true;
    }
    return false;
}

function resolveSourceRoot(rawSource) {
    if (rawSource) {
        const explicit = path.resolve(process.cwd(), rawSource);
        if (!fs.existsSync(explicit)) {
            throw new Error(`Source folder not found: ${explicit}`);
        }
        return explicit;
    }

    const candidates = [
        path.resolve(process.cwd(), '..', 'docs'),
        path.resolve(process.cwd(), '..', 'doc'),
        path.resolve(process.cwd(), 'doc'),
        path.resolve(process.cwd(), 'docs'),
    ];

    for (const candidate of candidates) {
        if (dirExists(candidate)) return candidate;
    }

    throw new Error('No markdown source folder found. Please set --source explicitly.');
}

function resolveMarkdownRoot(sourceRoot, mdRootArg = 'markdown') {
    const requested = path.resolve(sourceRoot, mdRootArg);
    if (dirExists(requested)) return requested;

    const fallbackTargets = [
        sourceRoot,
        path.join(sourceRoot, 'wiki'),
        path.join(sourceRoot, 'markdown'),
    ];

    for (const candidate of fallbackTargets) {
        if (hasMarkdownInDir(candidate)) return candidate;
    }

    if (fs.existsSync(requested)) return requested;

    throw new Error(`No markdown root found under source: ${sourceRoot} (md=${mdRootArg}).`);
}

const SOURCE_ROOT = resolveSourceRoot(args.source);
const MD_ROOT = resolveMarkdownRoot(SOURCE_ROOT, args.md || 'markdown');
const QA_ROOT = path.join(SOURCE_ROOT, args.qa || 'qa');
const PUBLIC_ROOT = path.resolve(process.cwd(), args.output || 'public');
const ENCRYPT_CONTENT = parseBoolean(args['encrypt-content'] ?? args.encrypt, true);
const OUTPUT = path.join(PUBLIC_ROOT, ENCRYPT_CONTENT ? 'content.enc.json' : 'content.json');
const PAGE_OUTPUT_ROOT = path.join(PUBLIC_ROOT, 'content', 'pages');

function cleanName(name) {
    return name.replace(/^\d+-/, '').replace(/\.md$/, '').replace(/--/g, ' – ').replace(/-/g, ' ');
}

function buildTree(dir, relativePath = '') {
    if (!fs.existsSync(dir)) return [];
    const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => !e.name.startsWith('.') && e.name !== 'assets' && e.name !== 'content-manifest.json' && e.name !== 'INDEX.md')
        .sort((a, b) => a.name.localeCompare(b.name, 'ko'));

    return entries.map(entry => {
        const relative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        const slug = relative.replace(/\.md$/, '');

        if (entry.isDirectory()) {
            return { name: cleanName(entry.name), slug, isDir: true, children: buildTree(path.join(dir, entry.name), relative) };
        }
        if (entry.name.endsWith('.md')) {
            return { name: cleanName(entry.name), slug, isDir: false };
        }
        return null;
    }).filter(Boolean);
}

async function collectAndPersistPages(dir, password, relativePath = '') {
    const pages = {};
    if (!fs.existsSync(dir)) return pages;

    const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => !e.name.startsWith('.') && e.name !== 'assets' && e.name !== 'content-manifest.json' && e.name !== 'INDEX.md');

    for (const entry of entries) {
        const relative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            Object.assign(pages, await collectAndPersistPages(path.join(dir, entry.name), password, relative));
        } else if (entry.name.endsWith('.md')) {
            const slug = relative.replace(/\.md$/, '');
            const plain = fs.readFileSync(path.join(dir, entry.name), 'utf-8');
            const outputRel = `content/pages/${slug}.${ENCRYPT_CONTENT ? 'enc.json' : 'json'}`;
            const outputAbs = path.join(PUBLIC_ROOT, ...outputRel.split('/'));
            fs.mkdirSync(path.dirname(outputAbs), { recursive: true });

            if (ENCRYPT_CONTENT) {
                const encrypted = await encrypt(plain, password);
                fs.writeFileSync(outputAbs, JSON.stringify(encrypted));
            } else {
                fs.writeFileSync(outputAbs, JSON.stringify({ text: plain }));
            }

            pages[slug] = { path: outputRel };
        }
    }
    return pages;
}

function collectQA(dir, relativePath = '') {
    const qa = {};
    if (!fs.existsSync(dir)) return qa;

    const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => !e.name.startsWith('.'));

    for (const entry of entries) {
        const relative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            Object.assign(qa, collectQA(path.join(dir, entry.name), relative));
        } else if (entry.name.endsWith('.json')) {
            const slug = relative.replace(/\.json$/, '');
            try {
                qa[slug] = JSON.parse(fs.readFileSync(path.join(dir, entry.name), 'utf-8'));
            } catch (e) {
                console.warn(`⚠ Skipping invalid JSON: ${relative}`);
            }
        }
    }
    return qa;
}

async function askPassword() {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    return new Promise(resolve => {
        process.stderr.write('🔑 Enter encryption password: ');
        rl.question('', answer => { rl.close(); resolve(answer); });
    });
}

async function encrypt(plaintext, password) {
    const enc = new TextEncoder();
    const salt = webcrypto.getRandomValues(new Uint8Array(16));
    const iv = webcrypto.getRandomValues(new Uint8Array(12));

    const keyMaterial = await webcrypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    const key = await webcrypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt']
    );

    const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));

    return {
        salt: Buffer.from(salt).toString('base64'),
        iv: Buffer.from(iv).toString('base64'),
        ciphertext: Buffer.from(ciphertext).toString('base64'),
    };
}

async function main() {
    if (!fs.existsSync(SOURCE_ROOT)) {
        console.error(`❌ Source folder not found: ${SOURCE_ROOT}`);
        process.exit(1);
    }

    console.log('📚 Building wiki bundle...');
    console.log(`  📁 Source root: ${SOURCE_ROOT}`);
    console.log(`  📁 Markdown root: ${MD_ROOT}`);
    console.log(`  📁 QA root: ${QA_ROOT}`);
    console.log(`  📤 Output: ${OUTPUT}`);

    const structure = buildTree(MD_ROOT);
    const envPassword = args['password-env'] ? process.env[args['password-env']] : null;
    const password = args.password
        || envPassword
        || process.env.WIKI_PASSWORD
        || process.env.WIKI_ENCRYPTION_PASSWORD
        || await askPassword();
    const qa = collectQA(QA_ROOT);
    if (!password) {
        console.error('❌ No password provided');
        process.exit(1);
    }

    if (fs.existsSync(PAGE_OUTPUT_ROOT)) {
        fs.rmSync(PAGE_OUTPUT_ROOT, { recursive: true, force: true });
    }
    fs.mkdirSync(PAGE_OUTPUT_ROOT, { recursive: true });

    const pageIndex = await collectAndPersistPages(MD_ROOT, password);

    const bundle = { structure, pageIndex, qa };
    const plainJson = JSON.stringify(bundle);

    console.log(`  ✅ ${Object.keys(pageIndex).length} markdown pages`);
    console.log(`  ✅ ${Object.keys(qa).length} QA sets`);
    console.log(`  📦 Bundle size: ${(plainJson.length / 1024).toFixed(1)} KB`);

    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    if (ENCRYPT_CONTENT) {
        console.log('🔐 Encrypting...');
        const encrypted = await encrypt(plainJson, password);
        fs.writeFileSync(OUTPUT, JSON.stringify(encrypted));
        console.log(`✅ Encrypted bundle saved to ${OUTPUT}`);
        console.log(`  📦 Encrypted size: ${(fs.statSync(OUTPUT).size / 1024).toFixed(1)} KB`);
    } else {
        fs.writeFileSync(OUTPUT, JSON.stringify(bundle));
        console.log(`✅ Plain bundle saved to ${OUTPUT}`);
        console.log(`  📦 Plain size: ${(fs.statSync(OUTPUT).size / 1024).toFixed(1)} KB`);
    }
}

main().catch(e => { console.error(e); process.exit(1); });
