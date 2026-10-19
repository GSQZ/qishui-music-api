const { QishuiError, mediaUrl } = require('./client.cjs');

// Plays only plaintext resources issued by the car service. No key extraction or CENC decryption.
const levels = { medium: 'standard', higher: 'high', highest: 'high', lossless: 'lossless', hi_res: 'hires' };
const rank = value => ['standard', 'high', 'lossless', 'hires'].indexOf(value);
const encrypted = item => Boolean(item.encrypt_info?.encrypt || item.encrypt_info?.spade_a || item.PlayAuth || Number(item.Encrypt || 0));
async function resolveAudio(client, track, requested, onAudioSource = () => {}) {
    const player = track.player_info;
    if (!player) throw new QishuiError('not-playable', 'Qishui returned no player information');
    for (const variant of ['full', 'preview']) {
        const info = player[variant]?.video_model_info;
        if (!info) continue;
        const candidates = [];
        if (info.video_model) {
            let model;
            try { model = typeof info.video_model === 'string' ? JSON.parse(info.video_model) : info.video_model; }
            catch { throw new QishuiError('invalid-response', 'Invalid Qishui player model'); }
            for (const item of model.video_list || []) {
                if (encrypted(item) || !item.main_url) continue;
                candidates.push({ url: mediaUrl(item.main_url), quality: levels[item.video_meta?.quality] || 'standard',
                    bitrate: Number(item.video_meta?.bitrate || 0) });
            }
        }
        if (!candidates.length && info.url_player_info) {
            const { data } = await client.http(mediaUrl(info.url_player_info));
            const list = data.Result?.Data?.PlayInfoList || data.data?.PlayInfoList || data.PlayInfoList;
            if (!Array.isArray(list)) throw new QishuiError('invalid-response', 'Qishui PlayInfoList is missing');
            for (const item of list) {
                if (encrypted(item) || !item.MainPlayUrl) continue;
                candidates.push({ url: mediaUrl(item.MainPlayUrl), quality: levels[item.Quality] || 'standard', bitrate: Number(item.Bitrate || 0) });
            }
        }
        if (!candidates.length) continue;
        const allowed = candidates.filter(item => rank(item.quality) <= rank(requested));
        const source = (allowed.length ? allowed : candidates).sort((a, b) => rank(b.quality) - rank(a.quality) || b.bitrate - a.bitrate)[0];
        onAudioSource(source.url);
        console.info('[Qishui] Plaintext audio issued', { quality: source.quality, preview: variant === 'preview' });
        return { url: source.url, quality: source.quality, fetchedAt: Date.now(),
            ...(Number(info.expire_at) > Date.now() / 1000 ? { expiresAt: Number(info.expire_at) * 1000 } : {}), preview: variant === 'preview' };
    }
    throw new QishuiError('unsupported', 'Qishui returned protected audio only; decryption is disabled');
}
module.exports = { resolveAudio, encrypted };
