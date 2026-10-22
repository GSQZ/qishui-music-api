import { describe, expect, it, vi } from 'vitest';
import { createQishuiApi, createQishuiDeviceId, isQishuiDeviceId, QISHUI_OPERATIONS } from '../index.cjs';

// Exercise the public API contract independently of any host bridge.
const setup = (fetch = vi.fn()) => {
    const deviceId = createQishuiDeviceId();
    const sessions = { deviceId, revision: 0, get: () => null, set: vi.fn(), clear: vi.fn() };
    return { fetch, api: createQishuiApi({ deviceId, sessions, fetch, log: vi.fn() }) };
};
describe('public Qishui API', () => {
    it('generates stable-format device identities and exports an immutable operation list', () => {
        for (let i = 0; i < 20; i++) expect(isQishuiDeviceId(createQishuiDeviceId())).toBe(true);
        for (const invalid of [null, 123, '123', 'a'.repeat(19)]) expect(isQishuiDeviceId(invalid)).toBe(false);
        expect(Object.isFrozen(QISHUI_OPERATIONS)).toBe(true);
    });
    it('rejects non-protocol operations before calling the transport', async () => {
        const { api, fetch } = setup();
        for (const operation of ['fetch', 'constructor', null, {}, 'create_playlist']) {
            expect(await api.request(operation as never)).toMatchObject({ ok: false, error: { code: 'unsupported' } });
        }
        expect(fetch).not.toHaveBeenCalled();
    });
    it('rejects malformed account operations before network access', async () => {
        const { api, fetch } = setup();
        const cases = [
            ['like_song', { id: '1' }],
            ['like_song', { id: 'x', liked: true }],
            ['playlist_add_tracks', { id: '1', ids: [] }],
            ['playlist_remove_tracks', { id: '1', ids: ['x'] }],
            ['check_tracks', { ids: ['not-an-id'] }],
            ['dislike_song', { id: '1', disliked: 'no' }],
        ] as const;
        for (const [operation, params] of cases) {
            expect(await api.request(operation as never, params as never))
                .toMatchObject({ ok: false, error: { code: 'invalid-response' } });
        }
        expect(fetch).not.toHaveBeenCalled();
    });
    it('rejects malformed parameters before network access', async () => {
        const { api, fetch } = setup();
        for (const params of [null, [], { query: {} }, { query: 'x', offset: -1 }, { query: 'x', limit: 0 }]) {
            expect(await api.request('search', params as never)).toMatchObject({ ok: false, error: { code: 'invalid-response' } });
        }
        expect(fetch).not.toHaveBeenCalled();
    });
    it.each([false, true])('sends refused media hosts to the injected warn, or to log without one (warn: %s)', async withWarn => {
        const deviceId = createQishuiDeviceId();
        const sessions = { deviceId, revision: 0, get: () => null, set: vi.fn(), clear: vi.fn() };
        const fetch = vi.fn(async (url: string) => url.includes('/client/token/get/') ? Response.json({ client_token: 'fixture-token' })
            : Response.json({ data: { media_list: [{ media_id: '1', track_entity: { base_info: { id: '1' }, player_info: { full: { video_model_info: {
                video_model: { video_list: [{ main_url: 'https://media.unknown.test/a.m4a?sign=fixture-private' }] } } } } } }] } }));
        const log = vi.fn();
        const warn = vi.fn();
        const api = createQishuiApi({ deviceId, sessions, fetch, log, ...(withWarn ? { warn } : {}) });
        const result = await api.request('audio', { id: '1', quality: 'standard' });
        expect(result).toEqual({ ok: false, error: { code: 'invalid-response', message: 'Untrusted Qishui media host' } });
        const sink = withWarn ? warn : log;
        expect(sink).toHaveBeenCalledWith('[Qishui] Skipped untrusted media hosts: media.unknown.test');
        expect(JSON.stringify([log.mock.calls, warn.mock.calls])).not.toContain('fixture-private');
    });
    it('does not expose request URLs or transport exception text', async () => {
        const { api } = setup(vi.fn().mockRejectedValue(new Error('https://private.test/?token=fixture-private')));
        const result = await api.request('search', { query: 'song' });
        expect(result).toEqual({ ok: false, error: { code: 'network', message: 'Qishui service could not be reached' } });
        expect(JSON.stringify(result)).not.toContain('fixture-private');
    });
});
