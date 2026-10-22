import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { track } from './fixtures';

// Scene request state belongs to the protocol package.
const { createFeed } = createRequire(import.meta.url)('../src/feed.cjs');
describe('car stream request state', () => {
    it('nests scene IDs and restarts on A-to-B-to-A switches, while continuation keeps the scene', async () => {
        const bodies: any[] = [];
        const platform = vi.fn(async (_path, body) => { bodies.push(body); return { items: [{ entity: { media: { track_entity: track() } } }], has_more: true }; });
        const feed = createFeed({ platform });
        await feed.songs({ scene: '33' }); await feed.songs({ scene: '33' }); await feed.songs({ scene: '8' }); await feed.songs({ scene: '33' });
        expect(bodies.map(body => body.is_first_request)).toEqual([true, false, true, true]);
        expect(bodies.map(body => body.with_client_cache)).toEqual([false, true, false, false]);
        expect(bodies.map(body => body.feed_preference.scene_mode_id)).toEqual([33, 33, 8, 33]);
        expect(bodies.every(body => body.cursor === undefined && body.scene_mode_id === undefined)).toBe(true);
    });
    it('reads scene groups and rejects a catalogue whose block list is missing', async () => {
        const modes = (data: unknown) => createFeed({ platform: vi.fn(async () => data) }).modes();
        await expect(modes({ feed_mode_block: [{ title: 'Mood', feed_mode: [{ entity: { feed_mode: { text: 'Folk', scene_mode: { scene_mode_id: 33 } } } }] }] }))
            .resolves.toEqual([{ id: '33', name: 'Folk', group: 'Mood', coverUrl: undefined }]);
        await expect(modes({ feed_mode_block: [] })).resolves.toEqual([]);
        for (const broken of [{}, { feed_mode_block: null }, { feed_mode_block: {} }]) {
            await expect(modes(broken)).rejects.toMatchObject({ code: 'invalid-response' });
        }
    });
    it('passes a preference mode name and rejects malformed preferences before any request', async () => {
        const platform = vi.fn(async () => ({ items: [], has_more: true }));
        const feed = createFeed({ platform });
        await feed.songs({ preference: 'familiar' });
        expect((platform.mock.calls[0] as any[])[1].feed_preference).toMatchObject({ preference_mode: 'familiar', scene_mode_id: null });
        for (const preference of [{}, ['fresh'], 1, true, '', 'Fresh', 'fresh mode', 'x'.repeat(40)]) {
            await expect(feed.songs({ preference })).rejects.toMatchObject({ code: 'invalid-response' });
        }
        await expect(feed.songs({ scene: '33', preference: 'fresh' })).rejects.toMatchObject({ code: 'invalid-response' });
        expect(platform).toHaveBeenCalledTimes(1);
    });
    it('drops an in-flight account stream if the listener signs out', async () => {
        let release!: (value: unknown) => void;
        const platform = vi.fn(() => new Promise(resolve => { release = resolve; }));
        const feed = createFeed({ platform }); const pending = feed.songs({ scene: '33' });
        await vi.waitFor(() => expect(platform).toHaveBeenCalled()); feed.clear();
        release({ items: [], has_more: false });
        await expect(pending).rejects.toMatchObject({ code: 'unavailable' });
    });
});
