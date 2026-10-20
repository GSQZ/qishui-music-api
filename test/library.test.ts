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
    it('returns an empty, complete list when the account has no liked playlist', async () => {
        const platform = vi.fn(async () => ({ playlists: [], has_more: false }));
        await expect(likedSongs(platform)).resolves.toEqual({ ids: [], whole: true, total: 0 });
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
