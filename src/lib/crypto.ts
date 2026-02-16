/**
 * crypto.ts — Client-side decryption (Web Crypto API)
 * Also handles encrypted localStorage for session progress.
 */

export interface WikiNode {
    name: string;
    slug: string;
    isDir: boolean;
    children?: WikiNode[];
}

export interface PageRef {
    path: string;
}

export interface QAItem {
    type: 'basic' | 'cloze';
    front: string;
    back: string;
}

export interface WikiBundle {
    structure: WikiNode[];
    pageIndex: Record<string, PageRef>;
    qa: Record<string, QAItem[]>;
}

export interface EncryptedPayload {
    salt: string;
    iv: string;
    ciphertext: string;
}

export function isEncryptedPayload(value: unknown): value is EncryptedPayload {
    if (!value || typeof value !== 'object') return false;

    const candidate = value as Record<string, unknown>;
    if (typeof candidate.salt !== 'string' || typeof candidate.iv !== 'string' || typeof candidate.ciphertext !== 'string') {
        return false;
    }

    if (!candidate.salt || !candidate.iv || !candidate.ciphertext) return false;
    return true;
}

function base64ToBuffer(b64: string): ArrayBuffer {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

function bufferToBase64(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

async function deriveKey(password: string, salt: ArrayBuffer): Promise<CryptoKey> {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

export async function decryptPayload(
    password: string,
    encrypted: EncryptedPayload
): Promise<string> {
    const salt = base64ToBuffer(encrypted.salt);
    const iv = base64ToBuffer(encrypted.iv);
    const ciphertext = base64ToBuffer(encrypted.ciphertext);

    const key = await deriveKey(password, salt);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, key, ciphertext);
    return new TextDecoder().decode(decrypted);
}

export async function decryptPayloadToJson<T>(
    password: string,
    encrypted: EncryptedPayload
): Promise<T> {
    const json = await decryptPayload(password, encrypted);
    return JSON.parse(json) as T;
}

export async function decryptPayloadBytes(
    password: string,
    encrypted: EncryptedPayload
): Promise<ArrayBuffer> {
    const salt = base64ToBuffer(encrypted.salt);
    const iv = base64ToBuffer(encrypted.iv);
    const ciphertext = base64ToBuffer(encrypted.ciphertext);

    const key = await deriveKey(password, salt);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, key, ciphertext);
    return decrypted;
}

export async function decryptContent(
    password: string,
    encrypted: EncryptedPayload
): Promise<WikiBundle> {
    const json = await decryptPayload(password, encrypted);
    return JSON.parse(json) as WikiBundle;
}

export async function decryptContentText(
    password: string,
    encrypted: EncryptedPayload
): Promise<string> {
    return decryptPayload(password, encrypted);
}

// --- Encrypted localStorage for learning progress ---

const PROGRESS_KEY = 'wiki_progress_v1';
const PROGRESS_SALT_KEY = 'wiki_progress_salt_v1';

async function getProgressKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
    return deriveKey(password, salt.buffer as ArrayBuffer);
}

export async function saveProgress(password: string, data: Record<string, unknown>): Promise<void> {
    try {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await getProgressKey(password, salt);
        const enc = new TextEncoder();
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(data)));

        localStorage.setItem(PROGRESS_SALT_KEY, bufferToBase64(salt.buffer as ArrayBuffer));
        localStorage.setItem(PROGRESS_KEY, JSON.stringify({
            iv: bufferToBase64(iv.buffer as ArrayBuffer),
            ciphertext: bufferToBase64(ciphertext),
        }));
    } catch {
        // Silently fail if localStorage unavailable
    }
}

export async function loadProgress(password: string): Promise<Record<string, unknown> | null> {
    try {
        const saltB64 = localStorage.getItem(PROGRESS_SALT_KEY);
        const raw = localStorage.getItem(PROGRESS_KEY);
        if (!saltB64 || !raw) return null;

        const { iv, ciphertext } = JSON.parse(raw);
        const salt = new Uint8Array(base64ToBuffer(saltB64));
        const key = await getProgressKey(password, salt);
        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: new Uint8Array(base64ToBuffer(iv)) },
            key,
            base64ToBuffer(ciphertext)
        );
        return JSON.parse(new TextDecoder().decode(decrypted));
    } catch {
        return null;
    }
}
