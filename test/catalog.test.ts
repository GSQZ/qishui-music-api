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
