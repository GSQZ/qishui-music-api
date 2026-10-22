const { QishuiError } = require('./client.cjs');
const { publicTrack } = require('./catalog.cjs');

// Account reads and writes the car client exposes through /luna/v1/platform.
// Albums are not part of the car protocol: `/media/mget/` rejects type "album",
// `/search/` has no album results, and there is no album endpoint.
const MAX_BATCH = 100;
const PAGE_SIZE = 100;
const PAGE_LIMIT = 500;

const mediaId = value => {
    if (typeof value !== 'string' || !/^\d{1,30}$/.test(value)) throw new QishuiError('invalid-response', 'Invalid Qishui media ID');
    return value;
};
const mediaIds = value => {
    if (!Array.isArray(value) || value.length === 0) throw new QishuiError('invalid-response', 'Qishui media IDs are required');
    if (value.length > MAX_BATCH) throw new QishuiError('unsupported', `Select at most ${MAX_BATCH} tracks per operation`);
    return [...new Set(value.map(mediaId))];
};
const trackRef = id => ({ id, type: 'track' });
const page = (items, hasMore, nextOffset) => ({ items, hasMore, nextOffset });
const boolean = value => {
    if (typeof value !== 'boolean') throw new QishuiError('invalid-response', 'Invalid Qishui boolean');
    return value;
};
// A missing list is a protocol failure; an explicitly empty array is a valid empty result.
const requiredList = (data, fields, label) => {
    const rows = fields.map(field => data?.[field]).find(Array.isArray);
    if (!rows) throw new QishuiError('invalid-response', `Qishui ${label} is missing`);
    return rows;
};

// The liked playlist is a regular playlist of type 1; its id is not fixed per account.
async function likedPlaylist(platform) {
    let cursor = '';
    const seen = new Set();
    for (let count = 0; count < 20; count++) {
        seen.add(cursor);
        const data = await platform('/me/playlist/', { count: PAGE_SIZE, cursor }, true);
        const rows = requiredList(data, ['playlists', 'playlist_list'], 'account playlists');
        for (const row of rows) {
            const playlist = row?.playlist || row || {};
            const base = playlist.base_info || {};
            if (Number(base.type) === 1 && base.id) return { id: String(base.id), ownerId: String(base.owner_id || '') };
        }
        if (data.has_more !== true) return null;
        const next = String(data.next_cursor ?? '');
        if (!next || seen.has(next)) throw new QishuiError('invalid-response', 'Account playlist cursor did not advance');
        cursor = next;
    }
    throw new QishuiError('invalid-response', 'Account playlist page limit reached');
}

async function likedSongs(platform) {
    const liked = await likedPlaylist(platform);
    // Not finding the liked playlist is not proof the account likes nothing; a complete empty
    // answer would let a host drop every liked song it has synced.
    if (!liked) throw new QishuiError('invalid-response', 'Qishui liked playlist was not found');
    const ids = new Set();
    let cursor = '';
    let whole = false;
    const seen = new Set();
    for (let count = 0; count < PAGE_LIMIT; count++) {
        seen.add(cursor);
        const data = await platform('/playlist/detail/', {
            playlist_id: liked.id, owner_id: liked.ownerId, count: PAGE_SIZE, cursor, type: 1,
        });
        const media = requiredList(data, ['media_entities', 'media_list'], 'liked playlist tracks');
        for (const item of media) {
            const id = publicTrack(item).id;
            if (id) ids.add(id);
        }
        if (data.has_more !== true) { whole = true; break; }
        const next = String(data.next_cursor ?? '');
        if (!next || seen.has(next)) throw new QishuiError('invalid-response', 'Liked playlist cursor did not advance');
        cursor = next;
    }
    return { ids: [...ids], whole, total: ids.size };
}

async function recentPlayed(platform, limit, offset) {
    const items = [];
    let cursor = '';
    let consumed = 0;
    let hasMore = false;
    for (let count = 0; count < PAGE_LIMIT; count++) {
        const data = await platform('/me/recent-played/', {
            count: PAGE_SIZE, cursor, media_type: 'track', scene: 'me_tab',
        }, true);
        // A page without its list cannot also claim more pages; that would walk the cursor for nothing.
        if (!Array.isArray(data.media) && data.has_more === true) throw new QishuiError('invalid-response', 'Qishui recent tracks are missing');
        const rows = Array.isArray(data.media) ? data.media : [];
        for (const row of rows) {
            const media = row?.media;
            if (!media?.track_entity) continue;
            const track = publicTrack(media);
            const rawPlayedAt = Number(row.play_start_timestamp);
            const playedAt = rawPlayedAt > 1e12 ? rawPlayedAt : rawPlayedAt * 1000;
            if (consumed >= offset && items.length < limit) {
                items.push({ ...track, ...(Number.isFinite(playedAt) && playedAt > 0 ? { playedAt } : {}) });
            }
            consumed++;
        }
        const upstreamMore = data.has_more === true;
        hasMore = consumed > offset + items.length || upstreamMore;
        if (!upstreamMore || items.length >= limit) break;
        const next = String(data.next_cursor ?? '');
        if (!next || next === cursor) throw new QishuiError('invalid-response', 'Recent-played cursor did not advance');
        cursor = next;
    }
    return page(items, hasMore && items.length > 0, offset + items.length);
}

async function checkTracks(platform, ids) {
    const data = await platform('/media/mcheck/', { media_list: ids.map(trackRef) });
    const rows = Array.isArray(data.media_status_list) ? data.media_status_list : [];
    return {
        statuses: rows.map(row => ({
            id: String(row.id ?? ''),
            riskResult: Number(row.risk_info?.risk_result ?? -1),
            status: Number(row.risk_info?.status ?? 0),
        })),
    };
}

function createLibrary(client) {
    const { platform, command } = client;
    return {
        likedSongs: () => likedSongs(platform),
        recentPlayed: ({ limit = 30, offset = 0 }) => recentPlayed(platform, limit, offset),
        async checkTracks({ ids }) {
            return checkTracks(platform, mediaIds(ids));
        },
        async likeSong({ id, liked }) {
            const trackId = mediaId(id);
            if (boolean(liked)) {
                await command('/media/collect/', { media: [trackRef(trackId)], scene: '', collect_action: 1 });
            } else {
                await command('/media/cancel/collect/', { media: [trackRef(trackId)] });
            }
        },
        async editPlaylist({ operation, id, ids }) {
            const playlistId = mediaId(id);
            const tracks = mediaIds(ids);
            const path = operation === 'add' ? '/playlist/append/' : '/playlist/delete/';
            if (operation !== 'add' && operation !== 'remove') throw new QishuiError('unsupported', 'Unsupported playlist operation');
            await command(path, { playlist_id: playlistId, media: tracks.map(trackRef) });
        },
        async dislikeSong({ id, disliked }) {
            const trackId = mediaId(id);
            await command('/dislike/', {
                item_id: trackId, author_ids: [], dislike_item_type: 'track', action_type: boolean(disliked) ? 0 : 1,
            });
        },
    };
}

module.exports = { createLibrary, likedPlaylist, likedSongs, recentPlayed, checkTracks };
