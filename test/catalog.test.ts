import { createRequire } from 'node:module';
import { describe, it, expect, vi } from 'vitest';
import { track } from './fixtures';

// Checks fixed-size search batches, opaque playlist cursors and account playlist shapes.
const { search, playlistPage, createCatalog, publicTrack } = createRequire(import.meta.url)('../src/catalog.cjs');
describe('Qishui car catalogue', () => {
    it('fills a requested search window without dropping the unused tail of a batch', async () => {
        const platform = vi.fn(async (_path: string, body: { cursor: string }) => {
            const start = Number(body.cursor);
            return { result_groups: [{ id: 'tracks', data: Array.from({ length: 20 }, (_, i) => ({ entity: { track: track(String(start + i + 1)) } })), has_more: true, next_cursor: String(start + 20) }] };
        });
        const page = await search(platform, 'song', 'track', 25, 0);
        expect(page.items.map((t: { id: string }) => t.id)).toEqual(Array.from({ length: 25 }, (_, i) => String(i + 1)));
        expect(page.nextOffset).toBe(25);
        expect(platform.mock.calls.map(call => call[1].cursor)).toEqual(['0', '20']);
        const next = await search(platform, 'song', 'track', 5, page.nextOffset);
        expect(next.items.map((t: { id: string }) => t.id)).toEqual(['26', '27', '28', '29', '30']);
    });
    it('walks opaque playlist cursors and keeps offsets into a larger upstream page', async () => {
        const platform = vi.fn(async (_path: string, body: { cursor: string }) => body.cursor === '0'
            ? { media_entities: [1, 2, 3].map(id => ({ track_entity: track(String(id)) })), has_more: true, next_cursor: 'next:abc' }
            : { media_entities: [4, 5].map(id => ({ track_entity: track(String(id)) })), has_more: false });
        const page = await playlistPage(platform, '99', '', 3, 2);
        expect(page.items.map((t: { id: string }) => t.id)).toEqual(['3', '4', '5']);
        expect(page).toMatchObject({ hasMore: false, nextOffset: 5 });
        expect(platform.mock.calls[1][1].cursor).toBe('next:abc');
    });
    it('rejects an upstream cursor that stalls rather than claiming the collection is complete', async () => {
        await expect(playlistPage(async () => ({ media_entities: [{ track_entity: track() }], has_more: true, next_cursor: '0' }), '99', '', 10, 0))
            .rejects.toMatchObject({ code: 'invalid-response' });
    });
    it('merges owned playlists and mixed saved playlists, retaining ownership', async () => {
        const platform = vi.fn(async (path: string, _body?: unknown, _personal?: boolean) => path === '/me/playlist/'
            ? { playlists: [{ base_info: { id: '1', title: 'Owned' } }], has_more: false }
            : { mixed_collections: [{ id: '2', playlist: { base_info: { id: '2', title: 'Saved' } } }], has_more: false });
        const page = await createCatalog({ platform }).user_playlists({ limit: 10, offset: 0 });
        expect(page.items.map((p: { isOwned: boolean }) => p.isOwned)).toEqual([true, false]);
        expect(platform.mock.calls.every(call => call[2] === true)).toBe(true);
    });
    it('does not pass player models or keys across the renderer bridge', () => {
        expect(publicTrack({ ...track(), player_info: { full: { secret: 'excluded' } } })).not.toHaveProperty('player_info');
    });
});
describe('playlist page resume points', () => {
    // 3000 rows in upstream pages of 100 behind opaque cursors.
    const upstream = (total = 3000) => vi.fn(async (_path: string, body: { cursor: string }) => {
        const start = body.cursor === '0' ? 0 : Number(body.cursor.slice('opaque:'.length));
        const end = Math.min(start + 100, total);
        return { ...(start === 0 ? { playlist: { base_info: { id: '99', title: 'Long' } } } : {}),
            media_entities: Array.from({ length: end - start }, (_, i) => ({ track_entity: track(String(start + i + 1)) })),
            has_more: end < total, next_cursor: `opaque:${end}` };
    });
    const sessions = (userId = 'fixture-user') => ({ current: { userId } as { userId: string } | null, get() { return this.current; } });
    const readAll = async (catalog: any, ownerId = '') => {
        const ids: string[] = [];
        for (let offset = 0, more = true; more;) {
            const page = await catalog.playlist_tracks({ id: '99', ownerId, limit: 100, offset });
            ids.push(...page.items.map((t: { id: string }) => t.id));
            more = page.hasMore; offset = page.nextOffset;
        }
        return ids;
    };
    it('reads sequential pages of a long playlist in one upstream request each', async () => {
        const platform = upstream();
        const ids = await readAll(createCatalog({ platform, sessions: sessions() }));
        expect(ids).toEqual(Array.from({ length: 3000 }, (_, i) => String(i + 1)));
        expect(platform).toHaveBeenCalledTimes(30);
    });
    it('resumes inside an upstream page and keeps the first page collection', async () => {
        const platform = upstream();
        const catalog = createCatalog({ platform, sessions: sessions() });
        await catalog.playlist_tracks({ id: '99', ownerId: '', limit: 30, offset: 0 });
        await catalog.playlist_tracks({ id: '99', ownerId: '', limit: 100, offset: 30 });
        platform.mockClear();
        const page = await catalog.playlist_tracks({ id: '99', ownerId: '', limit: 30, offset: 150 });
        expect(page.items.map((t: { id: string }) => t.id)).toEqual(Array.from({ length: 30 }, (_, i) => String(151 + i)));
        expect(page.collection).toMatchObject({ base_info: { title: 'Long' } });
        expect(platform.mock.calls.map(call => call[1].cursor)).toEqual(['opaque:100']);
    });
    it('keeps owners apart and starts over after an account switch', async () => {
        const platform = upstream();
        const accounts = sessions();
        const catalog = createCatalog({ platform, sessions: accounts });
        await catalog.playlist_tracks({ id: '99', ownerId: 'a', limit: 100, offset: 0 });
        platform.mockClear();
        await catalog.playlist_tracks({ id: '99', ownerId: 'b', limit: 100, offset: 100 });
        expect(platform.mock.calls.map(call => call[1].cursor)).toEqual(['0', 'opaque:100']);
        platform.mockClear();
        accounts.current = { userId: 'another-user' };
        await catalog.playlist_tracks({ id: '99', ownerId: 'b', limit: 100, offset: 200 });
        expect(platform.mock.calls[0][1].cursor).toBe('0');
        platform.mockClear();
        accounts.current = null;
        await catalog.playlist_tracks({ id: '99', ownerId: 'b', limit: 100, offset: 200 });
        expect(platform.mock.calls[0][1].cursor).toBe('0');
    });
    it('forgets resume points after they expire, after a failed walk and on request', async () => {
        let time = 0;
        const platform = upstream();
        const catalog = createCatalog({ platform, sessions: sessions() }, { now: () => time });
        const firstCursor = async (offset: number) => {
            platform.mockClear();
            await catalog.playlist_tracks({ id: '99', ownerId: '', limit: 100, offset });
            return platform.mock.calls[0][1].cursor;
        };
        await firstCursor(0);
        expect(await firstCursor(100)).toBe('opaque:100');
        time += 5 * 60 * 1000 + 1;
        expect(await firstCursor(200)).toBe('0');
        expect(await firstCursor(300)).toBe('opaque:300');
        platform.mockRejectedValueOnce(Object.assign(new Error('fixture'), { code: 'unavailable' }));
        await expect(catalog.playlist_tracks({ id: '99', ownerId: '', limit: 100, offset: 400 })).rejects.toThrow();
        expect(await firstCursor(400)).toBe('0');
        catalog.forgetPlaylist('99');
        expect(await firstCursor(500)).toBe('0');
        catalog.forgetPlaylist();
        expect(await firstCursor(600)).toBe('0');
    });
    it('caps how many playlists keep resume points', async () => {
        const platform = upstream(300);
        const catalog = createCatalog({ platform, sessions: sessions() });
        for (let id = 1; id <= 33; id++) await catalog.playlist_tracks({ id: String(id), ownerId: '', limit: 100, offset: 0 });
        platform.mockClear();
        await catalog.playlist_tracks({ id: '1', ownerId: '', limit: 100, offset: 100 });
        await catalog.playlist_tracks({ id: '33', ownerId: '', limit: 100, offset: 100 });
        expect(platform.mock.calls.map(call => call[1].cursor)).toEqual(['0', 'opaque:100', 'opaque:100']);
    });
});
