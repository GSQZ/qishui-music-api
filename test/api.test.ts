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
    it('does not expose request URLs or transport exception text', async () => {
        const { api } = setup(vi.fn().mockRejectedValue(new Error('https://private.test/?token=fixture-private')));
        const result = await api.request('search', { query: 'song' });
        expect(result).toEqual({ ok: false, error: { code: 'network', message: 'Qishui service could not be reached' } });
        expect(JSON.stringify(result)).not.toContain('fixture-private');
    });
});
