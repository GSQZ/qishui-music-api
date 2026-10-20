const { QISHUI_PREFIX: PREFIX, QISHUI_UA: UA, qishuiParams, qishuiGuardHeaders } = require('./protocol.cjs');

// Car HTTP client: public media and ticket-guard account requests use separate authentication.
class QishuiError extends Error {
    constructor(code, message, upstreamCode) { super(message); this.code = code; this.upstreamCode = upstreamCode; }
}
const AUTH_CODES = [28001003, 28001007, 28001008, 10007];
function checked(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new QishuiError('invalid-response', 'Invalid Qishui response');
    const code = Number(data.err_no ?? data.data?.error_code ?? 0);
    if (code) throw new QishuiError(AUTH_CODES.includes(code) ? 'auth-required' : 'unavailable', 'Qishui rejected the request', String(code));
    return data;
}
const HOSTS = ['365yg.com', 'douyinvod.com', 'douyinscdn.com', 'bytefcdn.com', 'bytecdn.cn', 'byteicdn.com', 'ibytedtos.com',
    'pstatp.com', 'snssdk.com', 'bytedance.com', 'bytetos.com', 'volcvideo.com', 'volccdn.com', 'volces.com',
    'volcengineapi.com', 'douyin.com', 'qishui.com', 'zijieapi.com'];
function mediaUrl(raw) {
    let url;
    try { url = new URL(raw); } catch { throw new QishuiError('invalid-response', 'Invalid Qishui media URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
        || !HOSTS.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
        throw new QishuiError('invalid-response', 'Untrusted Qishui media host');
    }
    return url.href;
}
function createClient({ sessions, fetch: fetcher = globalThis.fetch }) {
    let tokenTask;
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
    const clientToken = () => tokenTask ||= http(query(`https://open.qishui.com${PREFIX}/client/token/get/`, { trigger_type: 'cold_start' }))
        .then(({ data }) => {
            if (typeof data.client_token !== 'string' || !data.client_token) throw new QishuiError('invalid-response', 'Client token is missing');
            return data.client_token;
        }).catch(error => { tokenTask = undefined; throw error; });
    async function platform(path, body = {}, credential) {
        if (credential === true) {
            credential = sessions.get();
            if (!credential) throw new QishuiError('auth-required', 'Sign in to Qishui first');
        }
        const account = credential || sessions.get();
        const headers = credential ? qishuiGuardHeaders(credential, path) : { 'access-token': await clientToken() };
        const { data } = await http(query(`https://open.douyin.com${PREFIX}${path}`, {}, account?.deviceId), {
            body: { ...body, common_params: { ...(account?.userId ? { user_id: account.userId } : {}) } }, headers,
        });
        if (!data.data || typeof data.data !== 'object') throw new QishuiError('invalid-response', 'Qishui data is missing');
        return data.data;
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
    return { http, query, platform, command, sessions };
}
module.exports = { createClient, QishuiError, mediaUrl };
