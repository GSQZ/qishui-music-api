const { QISHUI_PREFIX: PREFIX, QISHUI_UA: UA, qishuiParams, qishuiGuardHeaders } = require('./protocol.cjs');

// Car HTTP client: public media and ticket-guard account requests use separate authentication.
class QishuiError extends Error {
    constructor(code, message, upstreamCode) { super(message); this.code = code; this.upstreamCode = upstreamCode; }
}
const AUTH_CODES = [28001003, 28001007, 28001008, 10007];
// Only known reads may be replayed. Account commands and future platform endpoints
// must not inherit a retry just because the car API uses POST for both reads and writes.
const RETRYABLE_READS = new Set(['/search/', '/playlist/detail/', '/media/mget/', '/media/mcheck/',
    '/artist/detail/', '/artist/tracks/', '/feed/mode/', '/feed/song-tab/']);
function checked(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new QishuiError('invalid-response', 'Invalid Qishui response');
    const code = Number(data.err_no ?? data.data?.error_code ?? 0);
    if (code) throw new QishuiError(AUTH_CODES.includes(code) ? 'auth-required' : 'unavailable', 'Qishui rejected the request', String(code));
    return data;
}
const HOSTS = ['365yg.com', 'douyinvod.com', 'douyinscdn.com', 'bytefcdn.com', 'bytecdn.cn', 'byteicdn.com', 'ibytedtos.com',
    'pstatp.com', 'snssdk.com', 'bytedance.com', 'bytetos.com', 'volcvideo.com', 'volccdn.com', 'volces.com',
    'volcengineapi.com', 'douyin.com', 'qishui.com', 'zijieapi.com', 'zjcdn.com'];
function mediaUrl(raw) {
    let url;
    try { url = new URL(raw); } catch { throw new QishuiError('invalid-response', 'Invalid Qishui media URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
        || !HOSTS.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
        throw new QishuiError('invalid-response', 'Untrusted Qishui media host');
    }
    return url.href;
}
// Names only the host of a refused media URL; its path and query may carry signatures.
function mediaHost(raw) {
    try { return new URL(raw).hostname || 'unknown host'; } catch { return 'invalid URL'; }
}
function createClient({ sessions, fetch: fetcher = globalThis.fetch, warn = console.warn }) {
    let tokenEntry;
    async function http(url, { body, headers = {}, form = false } = {}) {
        let response;
        try {
            response = await fetcher(url, { method: body === undefined ? 'GET' : 'POST',
                headers: { 'user-agent': UA, ...(body === undefined ? {} : { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' }), ...headers },
                ...(body === undefined ? {} : { body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) }),
                redirect: 'error', signal: AbortSignal.timeout(25000) });
        } catch { throw new QishuiError('network', 'Qishui service could not be reached'); }
        if (!response.ok) throw new QishuiError(response.status === 429 ? 'unavailable' : [401, 403].includes(response.status) ? 'auth-required' : 'network', `Qishui HTTP ${response.status}`);
        try { return { data: checked(await response.json()), headers: response.headers }; }
        catch (error) { if (error instanceof QishuiError) throw error; throw new QishuiError('invalid-response', 'Qishui response is not JSON'); }
    }
    const query = (path, extras = {}, deviceId = sessions.deviceId) => {
        const values = new URLSearchParams(qishuiParams(deviceId));
        Object.entries(extras).forEach(([key, value]) => values.set(key, String(value)));
        return `${path}?${values}`;
    };
    const clientToken = () => {
        if (!tokenEntry) {
            const entry = {};
            entry.task = http(query(`https://open.qishui.com${PREFIX}/client/token/get/`, { trigger_type: 'cold_start' }))
                .then(({ data }) => {
                    if (typeof data.client_token !== 'string' || !data.client_token) throw new QishuiError('invalid-response', 'Client token is missing');
                    return data.client_token;
                }).catch(error => { if (tokenEntry === entry) tokenEntry = undefined; throw error; });
            tokenEntry = entry;
        }
        return tokenEntry;
    };
    async function platform(path, body = {}, credential) {
        if (credential === true) {
            credential = sessions.get();
            if (!credential) throw new QishuiError('auth-required', 'Sign in to Qishui first');
        }
        const account = credential || sessions.get();
        const revision = sessions.revision;
        const request = async headers => {
            const { data } = await http(query(`https://open.douyin.com${PREFIX}${path}`, {}, account?.deviceId), {
                body: { ...body, common_params: { ...(account?.userId ? { user_id: account.userId } : {}) } }, headers,
            });
            if (!data.data || typeof data.data !== 'object') throw new QishuiError('invalid-response', 'Qishui data is missing');
            return data.data;
        };
        // Ticket-guard failures belong to the account flow, not the public client token.
        if (credential) return request(qishuiGuardHeaders(credential, path));
        let token = clientToken();
        for (let attempt = 0; ; attempt++) {
            const headers = { 'access-token': await token.task };
            if (attempt && revision !== sessions.revision) throw new QishuiError('unavailable', 'Qishui account changed during the request');
            try { return await request(headers); }
            catch (error) {
                if (!(error instanceof QishuiError) || error.upstreamCode !== '28001008') throw error;
                // A delayed failure for an old token cannot invalidate a newer generation.
                if (tokenEntry === token) tokenEntry = undefined;
                if (attempt || !RETRYABLE_READS.has(path)) throw error;
                // Share the replacement, including its failure, across concurrent expired reads.
                // A later independent request can acquire again after a failed token exchange.
                token = tokenEntry || (token.replacement ||= clientToken());
            }
        }
    }
    // Account writes (collect/playlist/dislike) use the ticket-guard credential and may answer without data.
    async function command(path, body = {}) {
        const credential = sessions.get();
        if (!credential) throw new QishuiError('auth-required', 'Sign in to Qishui first');
        const { data } = await http(query(`https://open.douyin.com${PREFIX}${path}`, {}, credential.deviceId), {
            body: { ...body, common_params: { ...(credential.userId ? { user_id: credential.userId } : {}) } },
            headers: qishuiGuardHeaders(credential, path),
        });
        return data.data && typeof data.data === 'object' ? data.data : {};
    }
    return { http, query, platform, command, sessions, warn };
}
module.exports = { createClient, QishuiError, mediaUrl, mediaHost };
