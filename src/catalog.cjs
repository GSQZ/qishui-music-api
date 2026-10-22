const { randomUUID } = require('node:crypto');
const { QishuiError } = require('./client.cjs');

// Car catalogue reads preserve opaque playlist cursors and the search endpoint's fixed batch size.
const array = (value, field) => {
    if (!Array.isArray(value)) throw new QishuiError('invalid-response', `Qishui ${field} is missing`);
    return value;
};
const publicTrack = raw => {
    const track = raw?.track_entity || raw?.entity?.media?.track_entity || raw?.entity?.track || raw?.track || raw;
    if (!track?.base_info?.id && !track?.id) throw new QishuiError('invalid-response', 'Qishui track identity is missing');
    // Player models may carry encryption material. Only catalogue and lyric data cross the bridge.
    return { id: String(track.base_info?.id || track.id), base_info: track.base_info,
        related_info: track.related_info, display_info: track.display_info, commerce_info: track.commerce_info };
};
async function search(platform, query, type, limit, offset) {
    const items = [];
    const searchId = randomUUID();
    let cursor = offset;
    let more = false;
    while (items.length < limit) {
        const data = await platform('/search/', { q: query, cursor: String(cursor), search_id: searchId, from_search_id: searchId,
            search_method: 'input', search_type: type, search_scene: 'normal', scene_name: 'search', ab_param: '', last_viewed_media: {} });
        const groups = array(data.result_groups, 'search groups');
        const group = groups.find(value => value.id === `${type}s`) || groups[0];
        if (!group) break;
        const batch = array(group.data, 'search items').map(value => value.entity?.[type]).filter(Boolean);
        const remaining = limit - items.length;
        items.push(...batch.slice(0, remaining));
        more = batch.length > remaining || group.has_more === true;
        if (!batch.length || !more || items.length === limit) break;
        const next = Number(group.next_cursor);
        if (!Number.isSafeInteger(next) || next <= cursor) throw new QishuiError('invalid-response', 'Search cursor did not advance');
        cursor = next;
    }
    return { items: type === 'track' ? items.map(publicTrack) : items, hasMore: more && items.length > 0, nextOffset: offset + items.length };
}
// Playlist cursors are not row numbers, so an offset is reached by walking from the beginning.
// `marks` (optional) remembers the cursor found after each row count so the next page can resume there.
async function playlistPage(platform, id, ownerId, limit, offset, marks) {
    let lineage = { cursor: '0' };
    let consumed = 0;
    for (const [position, mark] of marks?.positions || []) {
        if (position <= offset && position > consumed) { consumed = position; lineage = mark; }
    }
    let cursor = lineage.cursor;
    // Resume with this cursor's ancestors, not unrelated later marks. Linked nodes share
    // history between pages without retaining a copy of the whole visited set per mark.
    const seen = new Set();
    for (let ancestor = lineage; ancestor; ancestor = ancestor.previous) seen.add(ancestor.cursor);
    const items = [];
    let collection = consumed ? marks.collection : undefined;
    let hasMore = false;
    let pages = 0;
    while (items.length < limit && pages < 500) {
        pages++;
        seen.add(cursor);
        const data = await platform('/playlist/detail/', { playlist_id: id, owner_id: ownerId || '', count: 100, cursor, type: null });
        collection ||= data.playlist;
        if (marks && cursor === '0') marks.collection = data.playlist;
        const batch = array(data.media_entities, 'playlist tracks');
        const start = Math.max(0, offset - consumed);
        const remaining = limit - items.length;
        items.push(...batch.slice(start, start + remaining).map(publicTrack));
        consumed += batch.length;
        const next = String(data.next_cursor ?? '');
        const upstreamMore = data.has_more === true;
        const unused = consumed > offset + items.length;
        hasMore = unused || upstreamMore;
        // Reject cycles before caching or returning a full page; otherwise cached cursors
        // could silently repeat pages across calls.
        if (upstreamMore && seen.has(next)) throw new QishuiError('invalid-response', 'Playlist cursor did not advance');
        if (marks && upstreamMore && batch.length && next) {
            lineage = { cursor: next, previous: lineage };
            marks.positions.set(consumed, lineage);
        }
        if (!upstreamMore || items.length === limit) break;
        if (!batch.length || !next || seen.has(next)) throw new QishuiError('invalid-response', 'Playlist cursor did not advance');
        cursor = next;
    }
    if (pages >= 500 && items.length < limit && hasMore) throw new QishuiError('invalid-response', 'Playlist page limit reached');
    return { items, collection, hasMore: hasMore && items.length > 0, nextOffset: offset + items.length };
}
// Short-lived, per-account resume points for sequential playlist pages. Entries expire, are capped,
// are dropped after a failed walk or an edit through this API, and never outlive an account switch.
const CURSOR_TTL_MS = 5 * 60 * 1000;
const CURSOR_PLAYLISTS = 32;
function createPlaylistCursors(sessions, now = Date.now) {
    const entries = new Map();
    let account = null;
    const keyOf = (id, ownerId) => `${id}:${ownerId || ''}`;
    return {
        get(id, ownerId) {
            const user = sessions?.get()?.userId || '';
            if (user !== account) { entries.clear(); account = user; }
            const key = keyOf(id, ownerId);
            let entry = entries.get(key);
            if (entry && now() - entry.at > CURSOR_TTL_MS) entry = undefined;
            entries.delete(key);
            entry ||= { at: now(), positions: new Map(), collection: undefined };
            entries.set(key, entry);
            while (entries.size > CURSOR_PLAYLISTS) entries.delete(entries.keys().next().value);
            return entry;
        },
        forget(id) { for (const key of [...entries.keys()]) if (id == null || key.startsWith(`${id}:`)) entries.delete(key); },
    };
}
function createCatalog({ platform, sessions }, { now } = {}) {
    const cursors = createPlaylistCursors(sessions, now);
    return {
        forgetPlaylist: id => cursors.forget(id),
        search: ({ query, limit, offset }) => search(platform, query, 'track', limit, offset),
        search_playlists: ({ query, limit, offset }) => search(platform, query, 'playlist', limit, offset),
        async track(id) {
            const data = await platform('/media/mget/', { media_list: [{ id, type: 'track' }], card_context: {} });
            const media = array(data.media_list, 'media list').find(item => String(item.media_id || item.track_entity?.base_info?.id) === id);
            if (!media?.track_entity) throw new QishuiError('not-playable', 'Qishui did not return the track');
            return media.track_entity;
        },
        async playlist_tracks({ id, ownerId, limit, offset }) {
            try { return await playlistPage(platform, id, ownerId, limit, offset, cursors.get(id, ownerId)); }
            catch (error) { cursors.forget(id); throw error; }
        },
        async user_playlists({ limit, offset }) {
            const items = [];
            for (const [path, field, owned] of [['/me/playlist/', 'playlists', true], ['/me/collection/mixed/', 'mixed_collections', false]]) {
                let cursor = '';
                const seen = new Set();
                for (let page = 0; page < 500; page++) {
                    seen.add(cursor);
                    const data = await platform(path, { count: 100, cursor, item_types: ['playlist'] }, true);
                    const rows = data[field] ?? (path === '/me/playlist/' ? data.playlist_list : undefined);
                    for (const row of array(rows, field)) {
                        const playlist = row.playlist || row;
                        if (playlist.base_info?.id) items.push({ ...playlist, isOwned: owned });
                    }
                    if (!data.has_more) break;
                    const next = String(data.next_cursor ?? '');
                    if (!next || seen.has(next) || !rows.length || page === 499) throw new QishuiError('invalid-response', 'Account playlist cursor did not advance');
                    cursor = next;
                }
            }
            const unique = [...new Map(items.map(item => [String(item.base_info.id), item])).values()];
            return { items: unique.slice(offset, offset + limit), total: unique.length,
                nextOffset: offset + Math.min(limit, Math.max(0, unique.length - offset)), hasMore: offset + limit < unique.length };
        },
        async artist_detail({ id }) { const data = await platform('/artist/detail/', { artist_id: id }); return data.artist_info; },
        async artist_songs({ id, limit, offset }) {
            // The car SDK reports has_more forever on empty artist pages. Its initial hot list is bounded.
            const data = await platform('/artist/tracks/', { artist_id: id, count: 50, cursor: '0' });
            const tracks = array(data.tracks, 'artist tracks').map(publicTrack);
            return { items: tracks.slice(offset, offset + limit), total: tracks.length, nextOffset: Math.min(offset + limit, tracks.length), hasMore: offset + limit < tracks.length };
        },
    };
}
module.exports = { createCatalog, publicTrack, search, playlistPage };
