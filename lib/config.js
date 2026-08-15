import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import z from '@deepseek-ai/schemastery';
/**
 * Plugin configuration (schemastery schema, DSH convention). All defaults are
 * security-first: loopback-only host, bearer-token auth, bounded result sizes.
 */
export const ConfigSchema = z.object({
    /** MCP transport: 'http' (Streamable HTTP) or 'stdio' (local MCP clients). */
    transport: z.union([z.const('http'), z.const('stdio')]).default('http'),
    /** Bind host for the Streamable HTTP server. Loopback only by default. */
    host: z.string().default('127.0.0.1'),
    /** Bind port for the Streamable HTTP server. */
    port: z.number().min(1).max(65535).default(3456),
    /** 'token' requires Authorization: Bearer <token>; 'none' disables auth (loopback only, not recommended). */
    authMode: z.union([z.const('token'), z.const('none')]).default('token'),
    /** Static token; empty falls back to authTokenEnv, then a generated token persisted to tokenFile. */
    authToken: z.string().default(''),
    /** Environment variable read when authToken is empty. */
    authTokenEnv: z.string().default('DSH_CHATGPT_BRIDGE_TOKEN'),
    /** Where a generated token is persisted; empty means $DSH_HOME/chatgpt-bridge.token. */
    tokenFile: z.string().default(''),
    /** Max characters of assistant text returned by dsh_get_result. */
    resultMaxChars: z.number().default(8000),
    /** Max tool calls returned by dsh_get_result. */
    resultMaxItems: z.number().default(50),
    /** Max message rows returned by dsh_get_session. */
    sessionMaxItems: z.number().default(20),
    /** Max characters per message text returned by dsh_get_session. */
    sessionMaxChars: z.number().default(4000),
    /** Log verbosity: debug | info | warn | error. */
    logLevel: z.union([z.const('debug'), z.const('info'), z.const('warn'), z.const('error')]).default('info'),
});
/** Read the persisted token file, if any. */
function readTokenFile(path) {
    try {
        const raw = readFileSync(path, 'utf8').trim();
        return raw === '' ? undefined : raw;
    }
    catch {
        return undefined;
    }
}
/** Generate a fresh token and persist it (0600 intent; Windows has no chmod). */
function createTokenFile(path) {
    const token = randomBytes(24).toString('base64url');
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, token + '\n', { encoding: 'utf8', flag: 'w' });
    }
    catch {
        // persistence failure is not fatal: the token still works for this process
    }
    return token;
}
export function defaultDshHome(env) {
    return env.DSH_HOME && env.DSH_HOME !== '' ? env.DSH_HOME : join(homeDir(), '.dsh');
}
function homeDir() {
    return process.env.USERPROFILE ?? process.env.HOME ?? '.';
}
/** Resolve the effective configuration (defaults + token resolution). */
export function resolveConfig(input, env) {
    const dshHome = defaultDshHome(env);
    const transport = input.transport === 'stdio' ? 'stdio' : 'http';
    const authMode = input.authMode === 'none' ? 'none' : 'token';
    const tokenEnv = input.authTokenEnv || 'DSH_CHATGPT_BRIDGE_TOKEN';
    const tokenFile = input.tokenFile && input.tokenFile !== '' ? input.tokenFile : join(dshHome, 'chatgpt-bridge.token');
    let authToken = input.authToken ?? '';
    if (authMode === 'token' && authToken === '') {
        authToken = env[tokenEnv] ?? '';
    }
    if (authMode === 'token' && authToken === '') {
        authToken = readTokenFile(tokenFile) ?? '';
    }
    if (authMode === 'token' && authToken === '') {
        authToken = createTokenFile(tokenFile);
    }
    return {
        transport,
        host: input.host || '127.0.0.1',
        port: input.port ?? 3456,
        authMode,
        authToken,
        tokenFile,
        resultMaxChars: input.resultMaxChars ?? 8000,
        resultMaxItems: input.resultMaxItems ?? 50,
        sessionMaxItems: input.sessionMaxItems ?? 20,
        sessionMaxChars: input.sessionMaxChars ?? 4000,
        logLevel: input.logLevel ?? 'info',
        dshHome,
    };
}
