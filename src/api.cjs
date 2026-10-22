const { isAccountId, isQishuiDeviceId } = require('./protocol.cjs');
const { createClient, QishuiError } = require('./client.cjs');
const { createAuth } = require('./auth.cjs');
const { createCatalog, publicTrack } = require('./catalog.cjs');
const { createFeed } = require('./feed.cjs');
const { createLibrary } = require('./library.cjs');
const { resolveAudio } = require('./playback.cjs');

// Public operations never accept an arbitrary host, token, raw request or signing key.
const QISHUI_OPERATIONS = Object.freeze(['login_status', 'logout', 'login_qr_key', 'login_qr_create', 'login_qr_check', 'login_qr_cancel',
    'search', 'search_playlists', 'song_detail', 'audio', 'lyrics', 'user_playlists', 'playlist_detail', 'playlist_tracks',
    'artist_detail', 'artist_songs', 'feed', 'feed_modes',
    'liked_songs', 'like_song', 'playlist_add_tracks', 'playlist_remove_tracks', 'recent_played', 'check_tracks', 'dislike_song']);
const idOf = value => {
    if (typeof value !== 'string' || !/^\d{1,30}$/.test(value)) throw new QishuiError('invalid-response', 'Invalid Qishui media ID');
    return value;
};
function createQishuiApi(options) {
    const { sessions, deviceId = sessions?.deviceId } = options;
    if (!isQishuiDeviceId(deviceId) || sessions?.deviceId !== deviceId
        || !['get', 'set', 'clear'].every(method => typeof sessions[method] === 'function')) {
        throw new TypeError('A valid device ID and session repository are required');
    }
    // Hosts that inject only `log` receive warnings there too; messages never carry URLs or credentials.
    const log = typeof options.log === 'function' ? options.log : console.info;
    const warn = typeof options.warn === 'function' ? options.warn : typeof options.log === 'function' ? options.log : console.warn;
    const client = createClient({ sessions, fetch: options.fetch, log, warn });
    const auth = createAuth(client, { log });
    const catalog = createCatalog(client);
    const feed = createFeed(client);
    const library = createLibrary(client);
    const nowUser = () => sessions.get()?.userId || null;
    return {
        async request(operation, raw = {}) {
            try {
                if (!QISHUI_OPERATIONS.includes(operation)) throw new QishuiError('unsupported', 'Unsupported Qishui operation');
                if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new QishuiError('invalid-response', 'Invalid Qishui parameters');
                const limit = Math.min(raw.limit ?? 30, 100);
                const offset = raw.offset ?? 0;
                if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(offset) || offset < 0 || offset > 50000) throw new QishuiError('invalid-response', 'Invalid Qishui page');
                const p = { limit, offset };
                if (['song_detail', 'audio', 'lyrics', 'playlist_detail', 'playlist_tracks', 'artist_detail', 'artist_songs'].includes(operation)) p.id = idOf(raw.id);
                if (raw.ownerId && !isAccountId(raw.ownerId)) throw new QishuiError('invalid-response', 'Invalid Qishui owner ID');
                if (operation.startsWith('search')) {
                    if (typeof raw.query !== 'string' || raw.query.length > 500) throw new QishuiError('invalid-response', 'Invalid Qishui search');
                    p.query = raw.query.trim();
                }
                if (operation.startsWith('login_qr_') && operation !== 'login_qr_key'
                    && (typeof raw.key !== 'string' || !/^[a-f0-9]{32}$/.test(raw.key))) throw new QishuiError('invalid-response', 'Invalid QR key');
                let data;
                const userId = nowUser();
                switch (operation) {
                    case 'login_qr_key': data = await auth.start(); break;
                    case 'login_qr_create': data = auth.qr(raw.key); break;
                    case 'login_qr_check':
                        data = await auth.check(raw.key);
                        // A newly authorized account starts a fresh stream and invalidates guest reads in flight.
                        if (data.state === 'confirmed') feed.clear();
                        break;
                    case 'login_qr_cancel': auth.cancel(raw.key); data = null; break;
                    case 'login_status': data = await auth.status(); break;
                    case 'logout': auth.logout(); feed.clear(); data = null; break;
                    case 'song_detail': data = publicTrack(await catalog.track(p.id)); break;
                    case 'lyrics': data = (await catalog.track(p.id)).display_info?.lyric_info || {}; break;
                    case 'audio': {
                        if (!['standard', 'high', 'lossless', 'hires'].includes(raw.quality)) throw new QishuiError('invalid-response', 'Invalid Qishui audio quality');
                        data = await resolveAudio(client, await catalog.track(p.id), raw.quality);
                        break;
                    }
                    case 'playlist_detail': case 'playlist_tracks':
                        data = await catalog.playlist_tracks({ ...p, ownerId: raw.ownerId || '' });
                        if (operation === 'playlist_detail') data = data.collection || null;
                        break;
                    case 'feed_modes': data = await feed.modes(); break;
                    case 'feed': data = await feed.songs({ scene: raw.scene, preference: raw.preference,
                        queue: raw.queue === 'explore' ? 'explore' : 'fm', first: raw.first === true, count: limit }); break;
                    case 'liked_songs': data = await library.likedSongs(); break;
                    case 'like_song': await library.likeSong({ id: idOf(raw.id), liked: raw.liked }); data = null; break;
                    case 'playlist_add_tracks':
                        await library.editPlaylist({ operation: 'add', id: idOf(raw.id), ids: raw.ids }); data = null; break;
                    case 'playlist_remove_tracks':
                        await library.editPlaylist({ operation: 'remove', id: idOf(raw.id), ids: raw.ids }); data = null; break;
                    case 'recent_played': data = await library.recentPlayed({ limit, offset }); break;
                    case 'check_tracks': data = await library.checkTracks({ ids: raw.ids }); break;
                    case 'dislike_song':
                        if (typeof raw.disliked !== 'boolean') throw new QishuiError('invalid-response', 'Invalid Qishui dislike');
                        await library.dislikeSong({ id: idOf(raw.id), disliked: raw.disliked }); data = null; break;
                    default:
                        data = p.query === '' ? { items: [], hasMore: false, nextOffset: offset } : await catalog[operation](p);
                }
                if (!['logout', 'login_status', 'login_qr_check'].includes(operation) && nowUser() !== userId) throw new QishuiError('unavailable', 'Qishui account changed during the request');
                return { ok: true, data };
            } catch (error) {
                // Only safe protocol errors cross IPC. Fetch exceptions may embed credential-bearing URLs.
                if (error instanceof QishuiError && typeof operation === 'string' && operation.startsWith('login')) {
                    warn(`[Qishui] Sign-in operation failed: ${[error.code, error.stage, error.upstreamCode].filter(Boolean).join(' ')}`);
                }
                if (error instanceof QishuiError) return { ok: false, error: { code: error.code, message: error.message, upstreamCode: error.upstreamCode, stage: error.stage } };
                return { ok: false, error: { code: 'invalid-response', message: 'Qishui operation failed' } };
            }
        },
    };
}
module.exports = { createQishuiApi, QISHUI_OPERATIONS };
