import { createRequire } from 'node:module';
import { describe, it, expect, vi } from 'vitest';
import { track } from './fixtures';

// The car account endpoints keep their protocol shapes: /media/collect, /playlist/append,
// /me/recent-played and /media/mcheck. No album or playlist-create endpoint exists on this client.
const { createLibrary, likedSongs, recentPlayed } = createRequire(import.meta.url)('../src/library.cjs');

const setup = ({ platform = vi.fn(async () => ({})), command = vi.fn(async () => ({})) } = {}) =>
    ({ platform, command, library: createLibrary({ platform, command }) });

describe('Qishui car account reads', () => {
    it('finds the liked playlist by type 1 and reads every page, keeping unique ids', async () => {
        let detail = 0;
        const platform = vi.fn(async (path: string, body: any) => {
            if (path === '/me/playlist/') {
                return body.cursor
                    ? { playlists: [{ base_info: { id: '99', type: 1, owner_id: '7' } }], has_more: false }
                    : { playlists: [{ base_info: { id: '1', type: 2 } }], has_more: true, next_cursor: 'p2' };
            }
            detail++;
            return detail === 1
                ? { media_entities: [{ track_entity: track('11') }], has_more: true, next_cursor: 'c2' }
                : { media_entities: [{ track_entity: track('11') }, { track_entity: track('12') }], has_more: false };
        });
        const result = await likedSongs(platform);
        expect(result).toEqual({ ids: ['11', '12'], whole: true, total: 2 });
        expect(platform.mock.calls[0][2]).toBe(true);
        expect(platform.mock.calls[2][1]).toMatchObject({ playlist_id: '99', owner_id: '7', type: 1 });
    });
    it('rejects an account answer without a liked playlist instead of reporting a complete empty list', async () => {
        const platform = vi.fn(async () => ({ playlists: [{ base_info: { id: '1', type: 2 } }], has_more: false }));
        await expect(likedSongs(platform)).rejects.toMatchObject({ code: 'invalid-response' });
        await expect(likedSongs(async () => ({ playlists: [], has_more: false }))).rejects.toMatchObject({ code: 'invalid-response' });
    });
    it('still reports a liked playlist that is explicitly empty as complete', async () => {
        const platform = vi.fn(async (path: string) => path === '/me/playlist/'
            ? { playlists: [{ base_info: { id: '99', type: 1 } }], has_more: false }
            : { media_entities: [], has_more: false });
        await expect(likedSongs(platform)).resolves.toEqual({ ids: [], whole: true, total: 0 });
    });
    it('rejects a missing playlist list instead of reporting a complete empty account', async () => {
        await expect(likedSongs(async () => ({ has_more: false })))
            .rejects.toMatchObject({ code: 'invalid-response' });
    });
    it.each(['', 'same'])('rejects a missing or repeated discovery cursor (%s)', async next_cursor => {
        await expect(likedSongs(async () => ({ playlists: [], has_more: true, next_cursor })))
            .rejects.toMatchObject({ code: 'invalid-response' });
    });
    it('rejects cyclic playlist discovery cursors before exhausting the page limit', async () => {
        const platform = vi.fn(async (_path: string, body: { cursor: string }) => ({
            playlists: [], has_more: true, next_cursor: body.cursor === 'a' ? 'b' : 'a',
        }));
        await expect(likedSongs(platform)).rejects.toMatchObject({ code: 'invalid-response' });
        expect(platform).toHaveBeenCalledTimes(3);
    });
    it('rejects unfinished discovery at the page limit instead of claiming no liked songs', async () => {
        let count = 0;
        const platform = vi.fn(async () => ({ playlists: [], has_more: true, next_cursor: String(++count) }));
        await expect(likedSongs(platform)).rejects.toMatchObject({ code: 'invalid-response' });
        expect(platform).toHaveBeenCalledTimes(20);
    });
    it.each([false, true])('rejects a missing track list, including after a valid page (%s)', async firstPage => {
        let detail = 0;
        const platform = vi.fn(async (path: string) => {
            if (path === '/me/playlist/') return { playlists: [{ base_info: { id: '99', type: 1 } }], has_more: false };
            if (firstPage && detail++ === 0) return { media_entities: [{ track_entity: track('1') }], has_more: true, next_cursor: 'next' };
            return {};
        });
        await expect(likedSongs(platform)).rejects.toMatchObject({ code: 'invalid-response' });
    });
    it('keeps the documented alternative list fields working', async () => {
        const platform = vi.fn(async (path: string) => path === '/me/playlist/'
            ? { playlist_list: [{ base_info: { id: '99', type: 1 } }], has_more: false }
            : { media_list: [{ track_entity: track('1') }], has_more: false });
        await expect(likedSongs(platform)).resolves.toEqual({ ids: ['1'], whole: true, total: 1 });
    });
    it('keeps unread tracks on the final upstream page available to the caller', async () => {
        const platform = vi.fn(async () => ({
            media: ['1', '2', '3'].map(id => ({ media: { track_entity: track(id) } })), has_more: false,
        }));
        const first = await recentPlayed(platform, 1, 0);
        expect(first).toMatchObject({ hasMore: true, nextOffset: 1 });
        expect(first.items.map((song: { id: string }) => song.id)).toEqual(['1']);
        const next = await recentPlayed(platform, 2, first.nextOffset);
        expect(next).toMatchObject({ hasMore: false, nextOffset: 3 });
        expect(next.items.map((song: { id: string }) => song.id)).toEqual(['2', '3']);
    });
    it('reads all recent tracks across upstream pages with different client page sizes', async () => {
        const platform = vi.fn(async (_path: string, body: { cursor: string }) => ({
            media: (body.cursor ? ['3', '4', '5'] : ['1', '2']).map(id => ({ media: { track_entity: track(id) } })),
            has_more: !body.cursor, next_cursor: 'opaque:next',
        }));
        const first = await recentPlayed(platform, 2, 0);
        const second = await recentPlayed(platform, 2, first.nextOffset);
        const third = await recentPlayed(platform, 2, second.nextOffset);
        expect([first.hasMore, second.hasMore, third.hasMore]).toEqual([true, true, false]);
        expect([...first.items, ...second.items, ...third.items].map((song: { id: string }) => song.id))
            .toEqual(['1', '2', '3', '4', '5']);
        expect(third.nextOffset).toBe(5);
    });
    it('rejects a recent-played page that claims more pages without its list', async () => {
        const platform = vi.fn(async () => ({ has_more: true, next_cursor: 'next' }));
        await expect(recentPlayed(platform, 30, 0)).rejects.toMatchObject({ code: 'invalid-response' });
        expect(platform).toHaveBeenCalledTimes(1);
    });
    it('keeps an empty listening history empty', async () => {
        await expect(recentPlayed(async () => ({ has_more: false }), 30, 0)).resolves.toEqual({ items: [], hasMore: false, nextOffset: 0 });
        await expect(recentPlayed(async () => ({ media: [], has_more: false }), 30, 0)).resolves.toEqual({ items: [], hasMore: false, nextOffset: 0 });
    });
    it('pages recent tracks by offset and turns their start timestamp into milliseconds', async () => {
        const platform = vi.fn(async () => ({
            media: [
                { media: { media_id: '1', track_entity: track('1') }, play_start_timestamp: 100 },
                { media: { media_id: '2', track_entity: track('2') }, play_start_timestamp: 1700000000 },
                { media: { media_id: '3', track_entity: track('3') }, play_start_timestamp: 1700000000000 },
            ],
            has_more: false,
        }));
        const page = await recentPlayed(platform, 2, 1);
        expect(page.items.map((song: { id: string }) => song.id)).toEqual(['2', '3']);
        expect(page.items[0].playedAt).toBe(1700000000000);
        expect(page.items[1].playedAt).toBe(1700000000000);
        expect(page).toMatchObject({ hasMore: false, nextOffset: 3 });
        expect(platform.mock.calls[0][1]).toMatchObject({ media_type: 'track', scene: 'me_tab' });
        expect(platform.mock.calls[0][2]).toBe(true);
    });
    it('reports track playability from /media/mcheck and validates its ids', async () => {
        const platform = vi.fn(async () => ({
            media_status_list: [{ id: '7', type: 'track', risk_info: { risk_result: 0, status: 0 } }],
        }));
        const library = createLibrary({ platform, command: vi.fn(async () => ({})) });
        await expect(library.checkTracks({ ids: ['7'] })).resolves.toEqual({ statuses: [{ id: '7', riskResult: 0, status: 0 }] });
        await expect(library.checkTracks({ ids: ['not-an-id'] })).rejects.toMatchObject({ code: 'invalid-response' });
        await expect(library.checkTracks({ ids: Array.from({ length: 101 }, (_, index) => String(index + 1)) }))
            .rejects.toMatchObject({ code: 'unsupported' });
    });
});

describe('Qishui car account writes', () => {
    it('collects and cancels collection through the car media endpoints', async () => {
        const { library, command } = setup();
        await library.likeSong({ id: '42', liked: true });
        expect(command).toHaveBeenLastCalledWith('/media/collect/', {
            media: [{ id: '42', type: 'track' }], scene: '', collect_action: 1,
        });
        await library.likeSong({ id: '42', liked: false });
        expect(command).toHaveBeenLastCalledWith('/media/cancel/collect/', { media: [{ id: '42', type: 'track' }] });
        await expect(library.likeSong({ id: '42', liked: 'yes' })).rejects.toMatchObject({ code: 'invalid-response' });
    });
    it('adds and removes playlist tracks in batches the car client accepts', async () => {
        const { library, command } = setup();
        await library.editPlaylist({ operation: 'add', id: '5', ids: ['1', '2', '2'] });
        expect(command).toHaveBeenLastCalledWith('/playlist/append/', {
            playlist_id: '5', media: [{ id: '1', type: 'track' }, { id: '2', type: 'track' }],
        });
        await library.editPlaylist({ operation: 'remove', id: '5', ids: ['1'] });
        expect(command).toHaveBeenLastCalledWith('/playlist/delete/', {
            playlist_id: '5', media: [{ id: '1', type: 'track' }],
        });
        await expect(library.editPlaylist({ operation: 'create', id: '5', ids: ['1'] }))
            .rejects.toMatchObject({ code: 'unsupported' });
        await expect(library.editPlaylist({ operation: 'add', id: '5', ids: [] }))
            .rejects.toMatchObject({ code: 'invalid-response' });
        await expect(library.editPlaylist({ operation: 'add', id: '5', ids: Array.from({ length: 101 }, (_, index) => String(index + 1)) }))
            .rejects.toMatchObject({ code: 'unsupported' });
    });
    it('sends the car dislike action and its cancellation', async () => {
        const { library, command } = setup();
        await library.dislikeSong({ id: '9', disliked: true });
        expect(command).toHaveBeenLastCalledWith('/dislike/', {
            item_id: '9', author_ids: [], dislike_item_type: 'track', action_type: 0,
        });
        await library.dislikeSong({ id: '9', disliked: false });
        expect(command).toHaveBeenLastCalledWith('/dislike/', expect.objectContaining({ action_type: 1 }));
        await expect(library.dislikeSong({ id: '9', disliked: 'no' })).rejects.toMatchObject({ code: 'invalid-response' });
    });
});
