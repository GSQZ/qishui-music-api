const { publicTrack } = require('./catalog.cjs');
const { QishuiError } = require('./client.cjs');

// Separate recommendation queues keep scene switches and exploration from consuming each other's stream.
function createFeed({ platform }) {
    const queues = new Map();
    let total = 0;
    let generation = 0;
    const activeKeys = new Map();
    let pending = Promise.resolve();
    return {
        clear() { generation++; queues.clear(); activeKeys.clear(); total = 0; },
        async modes() {
            const data = await platform('/feed/mode/');
            // An explicitly empty catalogue is valid; a missing one is a protocol failure the host can retry.
            if (!Array.isArray(data.feed_mode_block)) throw new QishuiError('invalid-response', 'Qishui feed modes are missing');
            return data.feed_mode_block.flatMap(block => (block.feed_mode || []).flatMap(item => {
                const mode = item.entity?.feed_mode;
                const id = mode?.scene_mode?.scene_mode_id;
                return id == null ? [] : [{ id: String(id), name: String(mode.text || ''), group: String(block.title || ''), coverUrl: mode.url_info }];
            }));
        },
        songs(options = {}) {
            const mine = generation;
            const run = async () => {
                if (mine !== generation) throw new QishuiError('unavailable', 'Qishui account changed');
                const { scene, preference, queue = 'fm', first = false, count = 20 } = options;
                // preference_mode is a short mode name such as `familiar` or `fresh`, never an object or free text.
                if (preference != null && (typeof preference !== 'string' || !/^[a-z][a-z_]{0,31}$/.test(preference))) throw new QishuiError('invalid-response', 'Invalid preference');
                if (scene != null && preference) throw new QishuiError('invalid-response', 'Scene and preference are mutually exclusive');
                if (scene != null && (!/^\d+$/.test(String(scene)) || !Number.isSafeInteger(Number(scene)))) throw new QishuiError('invalid-response', 'Invalid scene');
                const key = `${queue}:${scene ?? preference ?? 'default'}`;
                if (queues.size > 100) queues.clear();
                const previous = queues.get(key);
                const state = first || !previous || activeKeys.get(queue) !== key ? { count: 0, selectedAt: Date.now() } : previous;
                const data = await platform('/feed/song-tab/', { played_media: [], is_first_request: state.count === 0,
                    with_client_cache: state.count !== 0, is_did_first_request: false, count,
                    feed_preference: { scene_mode_id: scene == null ? null : Number(scene), scene_mode_select_time: scene == null ? null : state.selectedAt,
                        preference_mode: preference || null, total_request_count: ++total, preference_mode_request_count: state.count + 1, current_mode_request_count: state.count + 1 } });
                if (!Array.isArray(data.items)) throw new QishuiError('invalid-response', 'Qishui feed items are missing');
                if (mine !== generation) throw new QishuiError('unavailable', 'Qishui account changed');
                activeKeys.set(queue, key);
                state.count++;
                queues.set(key, state);
                return { items: data.items.filter(item => !item.type || item.type === 'track').map(publicTrack), hasMore: data.has_more === true };
            };
            const result = pending.then(run, run);
            pending = result.catch(() => {});
            return result;
        },
    };
}
module.exports = { createFeed };
