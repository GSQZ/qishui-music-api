const { QishuiError, mediaUrl, mediaHost } = require('./client.cjs');

// Plays only plaintext resources issued by the car service. No key extraction or CENC decryption.
const levels = { medium: 'standard', higher: 'high', highest: 'high', lossless: 'lossless', hi_res: 'hires' };
const rank = value => ['standard', 'high', 'lossless', 'hires'].indexOf(value);
const encrypted = item => Boolean(item.encrypt_info?.encrypt || item.encrypt_info?.spade_a || item.PlayAuth || Number(item.Encrypt || 0));
async function resolveAudio(client, track, requested) {
    const player = track.player_info;
    if (!player) throw new QishuiError('not-playable', 'Qishui returned no player information');
    // One unknown CDN must not fail a song another candidate can play; refused URLs are never returned.
    const refused = new Set();
    const trusted = raw => {
        try { return mediaUrl(raw); } catch { refused.add(mediaHost(raw)); return null; }
    };
    const report = () => {
        if (refused.size) (client.warn || console.warn)(`[Qishui] Skipped untrusted media hosts: ${[...refused].join(', ')}`);
    };
    for (const variant of ['full', 'preview']) {
        const info = player[variant]?.video_model_info;
        if (!info) continue;
        const candidates = [];
        let skipped = false;
        const add = (raw, quality, bitrate) => {
            const url = trusted(raw);
            if (url) candidates.push({ url, quality: levels[quality] || 'standard', bitrate: Number(bitrate || 0) });
            else skipped = true;
        };
        if (info.video_model) {
            let model;
            try { model = typeof info.video_model === 'string' ? JSON.parse(info.video_model) : info.video_model; }
            catch { throw new QishuiError('invalid-response', 'Invalid Qishui player model'); }
            for (const item of model.video_list || []) {
                if (encrypted(item) || !item.main_url) continue;
                add(item.main_url, item.video_meta?.quality, item.video_meta?.bitrate);
            }
        }
        if (!candidates.length && info.url_player_info) {
            const playInfo = trusted(info.url_player_info);
            if (playInfo) {
                const { data } = await client.http(playInfo);
                const list = data.Result?.Data?.PlayInfoList || data.data?.PlayInfoList || data.PlayInfoList;
                if (!Array.isArray(list)) throw new QishuiError('invalid-response', 'Qishui PlayInfoList is missing');
                for (const item of list) {
                    if (encrypted(item) || !item.MainPlayUrl) continue;
                    add(item.MainPlayUrl, item.Quality, item.Bitrate);
                }
            } else skipped = true;
        }
        if (!candidates.length) {
            // Plaintext existed but only on refused hosts: say so rather than quietly falling back to a preview.
            if (skipped) { report(); throw new QishuiError('invalid-response', 'Untrusted Qishui media host'); }
            continue;
        }
        report();
        const allowed = candidates.filter(item => rank(item.quality) <= rank(requested));
        const source = (allowed.length ? allowed : candidates).sort((a, b) => rank(b.quality) - rank(a.quality) || b.bitrate - a.bitrate)[0];
        (client.log || console.info)(`[Qishui] Plaintext audio issued: quality=${source.quality} preview=${variant === 'preview'}`);
        const clipStartMs = variant === 'preview' ? Number(player.preview?.duration?.start_ms) : 0;
        return { url: source.url, quality: source.quality, fetchedAt: Date.now(),
            ...(Number(info.expire_at) > Date.now() / 1000 ? { expiresAt: Number(info.expire_at) * 1000 } : {}), preview: variant === 'preview',
            ...(Number.isFinite(clipStartMs) && clipStartMs > 0 ? { clipStartMs } : {}) };
    }
    throw new QishuiError('unsupported', 'Qishui returned protected audio only; decryption is disabled');
}
module.exports = { resolveAudio, encrypted };
