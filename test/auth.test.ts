import { createRequire } from 'node:module';
import { describe, it, expect, vi } from 'vitest';

// A successful QR exchange must accept opaque IDs and restore the account after app restart.
const require = createRequire(import.meta.url);
const { createAuth } = require('../src/auth.cjs');
const { createQishuiApi } = require('../index.cjs');
const SESSION_KEY = 'session';
const createSessionRepository = ({ store }: any) => {
    let revision = 0;
    return { deviceId: '1234567890123456789', get revision() { return revision; },
        get: () => store.get(SESSION_KEY) ?? null,
        set: (value: unknown) => { revision++; store.set(SESSION_KEY, value); },
        clear: () => { revision++; store.delete(SESSION_KEY); } };
};
const { QishuiError } = require('../src/client.cjs');
const opaqueId = 'MS4wLjABAAAA_test-account-opaque-id';
function repository() {
    const saved = new Map<string, unknown>();
    const store = { get: (key: string) => saved.get(key), set: (key: string, value: unknown) => saved.set(key, value), delete: (key: string) => saved.delete(key) };
    return { saved, store, sessions: createSessionRepository({ store }) };
}
function clientFor(sessions: any, platform: (...args: any[]) => Promise<unknown> = vi.fn(async () => ({ my_info: { id: opaqueId, nickname: 'Listener' } }))) {
    const http = vi.fn(async (url: string) => {
        if (url.includes('/oauth/get_qrcode/')) return { data: { data: { token: 'test-qr-token', qrcode: 'dGVzdA==' } } };
        if (url.includes('/oauth/check_qrcode/')) return { data: { data: { status: 'confirmed', code: 'test-authorization-code' } } };
        if (url.includes('/access/code/get/')) return { data: { data: { access_code: 'test-access-code', open_id: 'test-open-id', expires_time: 21600 } } };
        if (url.includes('/get_access_ticket/')) return { data: { data: {} }, headers: new Headers({
            'bd-ticket-guard-server-data': Buffer.from(JSON.stringify({ ticket: 'test-ticket', ts_sign: 'test-signature', client_cert: 'test-certificate' })).toString('base64'),
        }) };
        throw new Error('Unexpected test endpoint');
    });
    return { sessions, platform, http, query: (url: string) => url };
}
describe('Qishui car sign-in', () => {
    it('completes an explicit QR sign-in with an opaque account ID and restores only its own session', async () => {
        const repo = repository();
        const client = clientFor(repo.sessions);
        const auth = createAuth(client, { log: vi.fn() });
        const { key } = await auth.start();
        await expect(auth.check(key)).resolves.toEqual({ state: 'confirmed' });
        expect(repo.sessions.get()).toMatchObject({ userId: opaqueId, user: { id: opaqueId } });
        expect(repo.saved.has(SESSION_KEY)).toBe(true);
        const restored = createSessionRepository({ store: repo.store });
        expect(restored.get()).toMatchObject({ userId: opaqueId });
        await expect(createAuth(clientFor(restored), { log: vi.fn() }).status()).resolves.toMatchObject({ id: opaqueId });
    });
    it('labels a malformed account response as an account-read failure rather than rejecting valid authorization', async () => {
        const repo = repository();
        const auth = createAuth(clientFor(repo.sessions, vi.fn(async () => ({ my_info: { nickname: 'Missing identity' } }))), { log: vi.fn() });
        const { key } = await auth.start();
        await expect(auth.check(key)).rejects.toMatchObject({ code: 'invalid-response', stage: 'account' });
        expect(repo.saved.has(SESSION_KEY)).toBe(false);
    });
    it('retains a network failure stage without inventing a platform rejection', async () => {
        const repo = repository();
        const auth = createAuth(clientFor(repo.sessions, vi.fn(async () => { throw new QishuiError('network', 'Service could not be reached'); })), { log: vi.fn() });
        const { key } = await auth.start();
        await expect(auth.check(key)).rejects.toMatchObject({ code: 'network', stage: 'account' });
    });
    it('does not restore an account if the user cancels during account validation', async () => {
        const repo = repository();
        let resolve!: (value: unknown) => void;
        const platform = vi.fn(() => new Promise(done => { resolve = done; }));
        const auth = createAuth(clientFor(repo.sessions, platform as any), { log: vi.fn() });
        const { key } = await auth.start();
        const result = auth.check(key);
        await vi.waitFor(() => expect(platform).toHaveBeenCalled());
        auth.cancel(key);
        resolve({ my_info: { id: opaqueId } });
        await expect(result).resolves.toEqual({ state: 'expired' });
        expect(repo.sessions.get()).toBeNull();
    });
});

describe('QR confirmation resets API feed state', () => {
    const setup = () => {
        const repo = repository();
        const authClient = clientFor(repo.sessions);
        const bodies: any[] = [];
        let held: (() => Promise<Response>) | undefined;
        let release!: (response: Response) => void;
        const fetch = vi.fn(async (url: string, options: { body?: string }) => {
            if (url.includes('/client/token/get/')) return Response.json({ client_token: 'test-client-token' });
            if (url.includes('/me/info/')) return Response.json({ data: { my_info: { id: opaqueId } } });
            if (url.includes('/feed/song-tab/')) {
                bodies.push(JSON.parse(options.body!));
                return held ? held() : Response.json({ data: { items: [], has_more: true } });
            }
            const { data, headers } = await authClient.http(url);
            return Response.json(data, { headers });
        });
        const bridge = createQishuiApi({ sessions: repo.sessions, deviceId: repo.sessions.deviceId, fetch, log: vi.fn() });
        return { bridge, bodies, hold: () => { held = () => new Promise(done => { release = done; }); },
            release: () => { held = undefined; release(Response.json({ data: { items: [], has_more: true } })); } };
    };
    const confirm = async (bridge: any) => {
        const started = await bridge.request('login_qr_key');
        expect(started.ok).toBe(true);
        expect(await bridge.request('login_qr_check', { key: started.data.key })).toEqual({ ok: true, data: { state: 'confirmed' } });
    };
    it('starts a new authenticated stream instead of continuing the guest queue', async () => {
        const { bridge, bodies } = setup();
        await bridge.request('feed'); await bridge.request('feed');
        await confirm(bridge);
        await bridge.request('feed');
        expect(bodies.map(body => body.is_first_request)).toEqual([true, false, true]);
        expect(bodies.map(body => body.with_client_cache)).toEqual([false, true, false]);
        expect(bodies[2].feed_preference.total_request_count).toBe(1);
    });
    it('invalidates a guest response still in flight when sign-in completes', async () => {
        const { bridge, bodies, hold, release } = setup();
        await bridge.request('feed');
        hold();
        const guest = bridge.request('feed');
        await vi.waitFor(() => expect(bodies).toHaveLength(2));
        await confirm(bridge);
        release();
        expect(await guest).toMatchObject({ ok: false, error: { code: 'unavailable' } });
        await bridge.request('feed');
        expect(bodies[2].is_first_request).toBe(true);
        expect(bodies[2].feed_preference.total_request_count).toBe(1);
    });
});
