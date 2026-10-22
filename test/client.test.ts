import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { createQishuiApi } from '../index.cjs';

// Synthetic car transport only: no live token lifetime, account or credentials are assumed.
const require = createRequire(import.meta.url);
const { createClient } = require('../src/client.cjs');
const { createQishuiGuard } = require('../src/protocol.cjs');
const deviceId = '1234567890123456789';
const expired = () => Response.json({ err_no: 28001008 });
const success = () => Response.json({ data: { result_groups: [], items: [] } });
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
};
const repository = (initial: any = null) => {
    let current = initial;
    let revision = 0;
    return { deviceId, get revision() { return revision; }, get: () => current,
        set: vi.fn((value: any) => { current = value; revision++; }),
        clear: vi.fn(() => { current = null; revision++; }) };
};
const credential = () => ({
    deviceId, ...createQishuiGuard(), ticket: 'fixture-ticket', guardCert: 'fixture-cert',
    guardTsSign: 'fixture-signature', userId: 'fixture-user', expiresAt: Date.now() + 86400000,
});
const harness = (options: { sessions?: ReturnType<typeof repository>, token?: (count: number) => Promise<Response> | Response,
    request?: (url: string, options: any) => Promise<Response> | Response } = {}) => {
    const sessions = options.sessions || repository();
    let tokenCalls = 0;
    const calls: { url: string, options: any }[] = [];
    const fetch = vi.fn(async (url: string, init: any) => {
        if (url.includes('/client/token/get/')) {
            tokenCalls++;
            return options.token ? options.token(tokenCalls) : Response.json({ client_token: `fixture-token-${tokenCalls}` });
        }
        calls.push({ url, options: init });
        return options.request ? options.request(url, init) : success();
    });
    return { sessions, calls, fetch, tokenCalls: () => tokenCalls, client: createClient({ sessions, fetch }),
        api: createQishuiApi({ sessions, deviceId, fetch, log: vi.fn() }) };
};

describe('public client token recovery', () => {
    it.each(['err_no', 'error_code'])('recovers a cached expired token (%s) without changing the account', async field => {
        let rejectOld = false;
        const sessions = repository(credential());
        const original = sessions.get();
        const setup = harness({ sessions, request: (_url, { headers }) =>
            rejectOld && headers['access-token'] === 'fixture-token-1'
                ? Response.json(field === 'err_no' ? { err_no: 28001008 } : { data: { error_code: 28001008 } }) : success() });
        expect(await setup.api.request('search', { query: 'song' })).toMatchObject({ ok: true });
        rejectOld = true;
        expect(await setup.api.request('search', { query: 'song' })).toMatchObject({ ok: true });
        expect(await setup.api.request('search', { query: 'song' })).toMatchObject({ ok: true });
        expect(setup.tokenCalls()).toBe(2);
        expect(setup.calls.map(call => call.options.headers['access-token']))
            .toEqual(['fixture-token-1', 'fixture-token-1', 'fixture-token-2', 'fixture-token-2']);
        expect(setup.calls[1].options.body).toBe(setup.calls[2].options.body);
        expect(sessions.get()).toBe(original);
        expect(sessions.set).not.toHaveBeenCalled();
        expect(sessions.clear).not.toHaveBeenCalled();
    });

    it('shares one refresh across simultaneous expired reads', async () => {
        const refreshing = deferred<Response>();
        const setup = harness({ token: count => count === 1
            ? Response.json({ client_token: 'fixture-token-1' }) : refreshing.promise,
        request: (_url, { headers }) => headers['access-token'] === 'fixture-token-1' ? expired() : success() });
        const reads = Array.from({ length: 12 }, () => setup.client.platform('/search/'));
        await vi.waitFor(() => expect(setup.calls).toHaveLength(12));
        expect(setup.tokenCalls()).toBe(2);
        refreshing.resolve(Response.json({ client_token: 'fixture-token-2' }));
        await expect(Promise.all(reads)).resolves.toHaveLength(12);
        expect(setup.tokenCalls()).toBe(2);
        expect(setup.calls).toHaveLength(24);
    });

    it.each(['/search/', '/playlist/detail/', '/media/mget/', '/media/mcheck/',
        '/artist/detail/', '/artist/tracks/', '/feed/mode/', '/feed/song-tab/'])
    ('allows exactly one expiry replay for the known public read %s', async path => {
        const setup = harness({ request: (_url, { headers }) =>
            headers['access-token'] === 'fixture-token-1' ? expired() : success() });
        await expect(setup.client.platform(path, { fixture: 'unchanged' })).resolves.toMatchObject({ items: [] });
        expect(setup.calls).toHaveLength(2);
        expect(setup.tokenCalls()).toBe(2);
        expect(setup.calls[0].options.body).toBe(setup.calls[1].options.body);
    });

    it.each([false, true])('does not let a late old-token failure invalidate a newer generation (same value: %s)', async sameValue => {
        const late = deferred<Response>();
        let oldCalls = 0;
        const setup = harness({
            token: count => Response.json({ client_token: sameValue ? 'same-fixture-token' : `fixture-token-${count}` }),
            request: () => {
                oldCalls++;
                if (oldCalls === 1) return late.promise;
                if (oldCalls === 2) return expired();
                return success();
            },
        });
        const delayed = setup.client.platform('/search/');
        await vi.waitFor(() => expect(setup.calls).toHaveLength(1));
        await setup.client.platform('/search/');
        expect(setup.tokenCalls()).toBe(2);
        late.resolve(expired());
        await delayed;
        await setup.client.platform('/search/');
        expect(setup.tokenCalls()).toBe(2);
        expect(setup.calls).toHaveLength(5);
        expect(setup.calls.slice(2).every(call => call.options.headers['access-token']
            === (sameValue ? 'same-fixture-token' : 'fixture-token-2'))).toBe(true);
    });

    it.each(['network', 'invalid-response'])('shares a failed refresh (%s), then allows a later independent attempt', async code => {
        const late = deferred<Response>();
        const refreshing = deferred<Response>();
        let oldCalls = 0;
        const setup = harness({
            token: async count => {
                if (count === 2) {
                    const result = await refreshing.promise;
                    if (code === 'network') throw new Error('fixture transport failure');
                    return result;
                }
                return Response.json({ client_token: `fixture-token-${count}` });
            },
            request: (_url, { headers }) => {
                if (headers['access-token'] !== 'fixture-token-1') return success();
                return ++oldCalls === 1 ? late.promise : expired();
            },
        });
        const first = setup.client.platform('/search/').catch((error: any) => error);
        await vi.waitFor(() => expect(setup.calls).toHaveLength(1));
        const second = setup.client.platform('/search/').catch((error: any) => error);
        await vi.waitFor(() => expect(setup.tokenCalls()).toBe(2));
        refreshing.resolve(Response.json({}));
        const failed = await second;
        expect(failed).toMatchObject({ code });
        late.resolve(expired());
        expect(await first).toBe(failed);
        expect(setup.tokenCalls()).toBe(2);
        expect(setup.calls).toHaveLength(2);
        await setup.client.platform('/search/');
        expect(setup.tokenCalls()).toBe(3);
        expect(setup.calls).toHaveLength(3);
    });

    it('limits each read to one replay and discards a rejected replacement for the next request', async () => {
        let rejecting = true;
        const setup = harness({ request: () => rejecting ? expired() : success() });
        expect(await setup.api.request('search', { query: 'song' }))
            .toMatchObject({ ok: false, error: { code: 'auth-required', upstreamCode: '28001008' } });
        expect(setup.tokenCalls()).toBe(2);
        expect(setup.calls).toHaveLength(2);
        rejecting = false;
        expect(await setup.api.request('search', { query: 'song' })).toMatchObject({ ok: true });
        expect(setup.tokenCalls()).toBe(3);
    });

    it.each([28001003, 28001007, 10007, 12345])('does not refresh for an unrelated upstream error (%s)', async code => {
        let rejecting = true;
        const setup = harness({ request: () => rejecting ? Response.json({ err_no: code }) : success() });
        await expect(setup.client.platform('/search/')).rejects.toMatchObject({ upstreamCode: String(code) });
        expect(setup.calls).toHaveLength(1);
        rejecting = false;
        await setup.client.platform('/search/');
        expect(setup.tokenCalls()).toBe(1);
    });

    it.each([401, 403, 429, 500])('does not assume a generic HTTP failure (%s) means token expiry', async status => {
        const setup = harness({ request: () => new Response(null, { status }) });
        await expect(setup.client.platform('/search/')).rejects.toBeInstanceOf(Error);
        expect(setup.tokenCalls()).toBe(1);
        expect(setup.calls).toHaveLength(1);
    });

    it('does not replay an unknown endpoint but invalidates the rejected public token', async () => {
        const setup = harness({ request: url => url.includes('/future-command/') ? expired() : success() });
        await expect(setup.client.platform('/future-command/')).rejects.toMatchObject({ upstreamCode: '28001008' });
        expect(setup.tokenCalls()).toBe(1);
        expect(setup.calls).toHaveLength(1);
        await setup.client.platform('/search/');
        expect(setup.tokenCalls()).toBe(2);
    });

    it('does not replay with stale account context if logout happens while refreshing', async () => {
        const refreshing = deferred<Response>();
        const setup = harness({ sessions: repository(credential()), token: count => count === 1
            ? Response.json({ client_token: 'fixture-token-1' }) : refreshing.promise,
        request: (_url, { headers }) => headers['access-token'] === 'fixture-token-1' ? expired() : success() });
        const read = setup.api.request('search', { query: 'song' });
        await vi.waitFor(() => expect(setup.tokenCalls()).toBe(2));
        expect(await setup.api.request('logout')).toEqual({ ok: true, data: null });
        refreshing.resolve(Response.json({ client_token: 'fixture-token-2' }));
        expect(await read).toMatchObject({ ok: false, error: { code: 'unavailable' } });
        expect(setup.calls).toHaveLength(1);
        expect(await setup.api.request('search', { query: 'song' })).toMatchObject({ ok: true });
        expect(JSON.parse(setup.calls[1].options.body).common_params).toEqual({});
        expect(setup.tokenCalls()).toBe(2);
    });

    it('recovers on the same API instance after logout and a successful QR sign-in', async () => {
        let rejectOld = false;
        const setup = harness({ request: (url, { headers }) => {
            if (url.includes('/search/')) return rejectOld && headers['access-token'] === 'fixture-token-1' ? expired() : success();
            if (url.includes('/oauth/get_qrcode/')) return Response.json({ data: { token: 'fixture-qr', qrcode: 'dGVzdA==' } });
            if (url.includes('/oauth/check_qrcode/')) return Response.json({ data: { status: 'confirmed', code: 'fixture-code' } });
            if (url.includes('/access/code/get/')) return Response.json({ data: { access_code: 'fixture-access', open_id: 'fixture-open', expires_time: 21600 } });
            if (url.includes('/get_access_ticket/')) return Response.json({ data: {} }, { headers: {
                'bd-ticket-guard-server-data': Buffer.from(JSON.stringify({
                    ticket: 'fixture-ticket', ts_sign: 'fixture-signature', client_cert: 'fixture-cert',
                })).toString('base64'),
            } });
            if (url.includes('/me/info/')) return Response.json({ data: { my_info: { id: 'fixture-user' } } });
            throw new Error('Unexpected fixture endpoint');
        } });
        expect(await setup.api.request('search', { query: 'song' })).toMatchObject({ ok: true });
        rejectOld = true;
        expect(await setup.api.request('logout')).toMatchObject({ ok: true });
        const started = await setup.api.request('login_qr_key');
        expect(started.ok).toBe(true);
        if (!started.ok) throw new Error('Fixture QR did not start');
        expect(await setup.api.request('login_qr_check', { key: (started.data as any).key }))
            .toEqual({ ok: true, data: { state: 'confirmed' } });
        expect(await setup.api.request('search', { query: 'song' })).toMatchObject({ ok: true });
        expect(setup.tokenCalls()).toBe(2);
        expect(setup.sessions.get()).toMatchObject({ userId: 'fixture-user' });
    });
});

describe('ticket-guard remains separate from public tokens', () => {
    it('does not reacquire the public token or replay an account read on ticket failure', async () => {
        const setup = harness({ sessions: repository(credential()),
            request: (url, { headers }) => {
                if (url.includes('/me/playlist/')) {
                    expect(headers['access-token']).toBe('fixture-ticket');
                    expect(headers['bd-ticket-guard-client-data']).toBeTruthy();
                    return expired();
                }
                return success();
            } });
        await setup.client.platform('/search/');
        await expect(setup.client.platform('/me/playlist/', {}, true)).rejects.toMatchObject({ upstreamCode: '28001008' });
        await setup.client.platform('/search/');
        expect(setup.tokenCalls()).toBe(1);
        expect(setup.calls).toHaveLength(3);
        expect(setup.sessions.clear).not.toHaveBeenCalled();
    });

    it.each([
        ['like_song', { id: '1', liked: true }, '/media/collect/'],
        ['like_song', { id: '1', liked: false }, '/media/cancel/collect/'],
        ['playlist_add_tracks', { id: '2', ids: ['1'] }, '/playlist/append/'],
        ['playlist_remove_tracks', { id: '2', ids: ['1'] }, '/playlist/delete/'],
        ['dislike_song', { id: '1', disliked: true }, '/dislike/'],
    ])('never automatically repeats the account mutation %s (%j)', async (operation, params, path) => {
        const setup = harness({ sessions: repository(credential()), request: (url, { headers }) => {
            if (url.includes(path as string)) {
                expect(headers['access-token']).toBe('fixture-ticket');
                expect(headers['bd-ticket-guard-client-data']).toBeTruthy();
                return expired();
            }
            return success();
        } });
        expect(await setup.api.request('search', { query: 'song' })).toMatchObject({ ok: true });
        expect(await setup.api.request(operation as any, params as any))
            .toMatchObject({ ok: false, error: { code: 'auth-required', upstreamCode: '28001008' } });
        expect(await setup.api.request('search', { query: 'song' })).toMatchObject({ ok: true });
        expect(setup.calls.filter(call => call.url.includes(path as string))).toHaveLength(1);
        expect(setup.tokenCalls()).toBe(1);
        expect(setup.sessions.clear).not.toHaveBeenCalled();
        expect(setup.sessions.set).not.toHaveBeenCalled();
    });
});

describe('stored account rejection during renewal', () => {
    const stored = (expiresAt = Date.now() + 86400000) => ({ ...credential(), accessCode: 'fixture-access', openId: 'fixture-open',
        user: { id: 'fixture-user', nickname: '', isVip: false }, expiresAt });
    const guardHeaders = { 'bd-ticket-guard-server-data': Buffer.from(JSON.stringify({
        ticket: 'fixture-ticket-2', ts_sign: 'fixture-signature', client_cert: 'fixture-cert' })).toString('base64') };
    it.each([28001003, 28001007, 28001008, 10007])('signs out when /me/info/ rejects the account ticket (%s)', async code => {
        const setup = harness({ sessions: repository(stored()), request: url => url.includes('/me/info/') ? Response.json({ err_no: code }) : success() });
        expect(await setup.api.request('login_status'))
            .toMatchObject({ ok: false, error: { code: 'auth-required', upstreamCode: String(code), stage: 'account' } });
        expect(setup.sessions.clear).toHaveBeenCalledTimes(1);
        expect(setup.sessions.get()).toBeNull();
        expect(await setup.api.request('login_status')).toEqual({ ok: true, data: null });
        expect(setup.calls.filter(call => call.url.includes('/me/info/'))).toHaveLength(1);
    });
    it.each(['/access/code/refresh/', '/get_access_ticket/'])('signs out when an expiring account cannot be renewed at %s', async path => {
        const setup = harness({ sessions: repository(stored(Date.now() + 60000)), request: url => {
            if (url.includes(path)) return Response.json({ err_no: 28001007 });
            if (url.includes('/access/code/refresh/')) return Response.json({ data: { access_code: 'fixture-access-2', expires_time: 21600 } });
            if (url.includes('/get_access_ticket/')) return Response.json({ data: {} }, { headers: guardHeaders });
            return Response.json({ data: { my_info: { id: 'fixture-user' } } });
        } });
        expect(await setup.api.request('login_status')).toMatchObject({ ok: false, error: { code: 'auth-required' } });
        expect(setup.sessions.clear).toHaveBeenCalledTimes(1);
    });
    it('signs out when the renewed ticket identifies a different account', async () => {
        const setup = harness({ sessions: repository(stored()), request: () => Response.json({ data: { my_info: { id: 'another-user' } } }) });
        expect(await setup.api.request('login_status')).toMatchObject({ ok: false, error: { code: 'auth-required' } });
        expect(setup.sessions.clear).toHaveBeenCalledTimes(1);
    });
    it.each([
        ['HTTP 401 without a platform code', () => new Response(null, { status: 401 })],
        ['HTTP 403 without a platform code', () => new Response(null, { status: 403 })],
        ['HTTP 500', () => new Response(null, { status: 500 })],
        ['an unrelated platform error', () => Response.json({ err_no: 12345 })],
        ['a transport failure', () => { throw new Error('fixture transport failure'); }],
        ['a response that is not JSON', () => new Response('not json')],
    ])('keeps the stored account after %s', async (_label, answer) => {
        const setup = harness({ sessions: repository(stored()), request: answer as () => Response });
        expect((await setup.api.request('login_status')).ok).toBe(false);
        expect(setup.sessions.clear).not.toHaveBeenCalled();
        expect(setup.sessions.get()).toMatchObject({ userId: 'fixture-user' });
    });
    it('does not sign out an account stored while the rejected renewal was in flight', async () => {
        const held = deferred<Response>();
        const setup = harness({ sessions: repository(stored()), request: () => held.promise });
        const pending = setup.api.request('login_status');
        await vi.waitFor(() => expect(setup.calls).toHaveLength(1));
        const replacement = { ...stored(), userId: 'next-user' };
        setup.sessions.set(replacement);
        held.resolve(Response.json({ err_no: 28001007 }));
        expect(await pending).toMatchObject({ ok: false, error: { code: 'auth-required' } });
        expect(setup.sessions.clear).not.toHaveBeenCalled();
        expect(setup.sessions.get()).toBe(replacement);
    });
    it('does not sign out when a public read exhausts its client-token recovery', async () => {
        const setup = harness({ sessions: repository(stored()), request: () => expired() });
        expect(await setup.api.request('search', { query: 'song' }))
            .toMatchObject({ ok: false, error: { code: 'auth-required', upstreamCode: '28001008' } });
        expect(setup.sessions.clear).not.toHaveBeenCalled();
    });
    it('restarts the recommendation stream after a rejected account is signed out', async () => {
        let rejecting = false;
        const bodies: any[] = [];
        const setup = harness({ sessions: repository(stored()), request: (url, { body }) => {
            if (url.includes('/me/info/')) return rejecting ? Response.json({ err_no: 28001003 }) : Response.json({ data: { my_info: { id: 'fixture-user' } } });
            bodies.push(JSON.parse(body));
            return success();
        } });
        await setup.api.request('feed'); await setup.api.request('feed');
        rejecting = true;
        expect((await setup.api.request('login_status')).ok).toBe(false);
        await setup.api.request('feed');
        expect(bodies.map(body => body.is_first_request)).toEqual([true, false, true]);
        expect(bodies[2].common_params).toEqual({});
    });
});

describe('playlist resume points through the API', () => {
    const detail = (body: any) => {
        const start = body.cursor === '0' ? 0 : Number(String(body.cursor).slice('opaque:'.length));
        return Response.json({ data: { media_entities: Array.from({ length: 100 }, (_, i) => ({
            track_entity: { base_info: { id: String(start + i + 1) } } })), has_more: start < 900, next_cursor: `opaque:${start + 100}` } });
    };
    it.each([
        ['nothing', null, null, 'opaque:100'],
        ['playlist_add_tracks', '/playlist/append/', { id: '99', ids: ['1'] }, '0'],
        ['playlist_remove_tracks', '/playlist/delete/', { id: '99', ids: ['1'] }, '0'],
        ['like_song', '/media/collect/', { id: '1', liked: true }, '0'],
    ])('resumes the next page unless %s changed playlists in between', async (operation, path, params, cursor) => {
        const setup = harness({ sessions: repository(credential()), request: (url, { body }) =>
            url.includes('/playlist/detail/') ? detail(JSON.parse(body)) : success() });
        expect(await setup.api.request('playlist_tracks', { id: '99', limit: 100, offset: 0 })).toMatchObject({ ok: true });
        if (path) {
            expect(await setup.api.request(operation as any, params as any)).toEqual({ ok: true, data: null });
            expect(setup.calls.some(call => call.url.includes(path))).toBe(true);
        }
        expect(await setup.api.request('playlist_tracks', { id: '99', limit: 100, offset: 100 })).toMatchObject({ ok: true });
        const reads = setup.calls.filter(call => call.url.includes('/playlist/detail/'));
        expect(JSON.parse(reads[1].options.body).cursor).toBe(cursor);
    });
});
