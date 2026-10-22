const crypto = require('node:crypto');
const { QISHUI_PREFIX: PREFIX, QISHUI_CLIENT_KEY: CLIENT_KEY, createQishuiGuard, readQishuiGuard, qishuiCredentialExpiry } = require('./protocol.cjs');
const { QishuiError } = require('./client.cjs');
const { isAccountId } = require('./protocol.cjs');

// Car QR authorization; credentials originate only from a QR explicitly requested by the listener.
const qrParams = () => ({ aid: '1128', client_key: CLIENT_KEY,
    scope: 'user_info,luna.openapi.platform.interaction,luna.openapi.platform.me_tab,luna.commerce.openapi_platform.vip_info',
    state: '', next: '', jump_type: 'native', optional_scope_check: '', optional_scope_uncheck: '',
    customize_params: '{"source":"pc_auth","not_skip_confirm":"true"}', source_from: 'native', device_platform: 'android',
    app_identity: crypto.createHash('md5').update('com.luna.music.car').digest('hex'), signature: 'cf9024ea72d9c71813238b13ea107a3d' });
function createAuth(client, { log = console.info } = {}) {
    const pending = new Map();
    let generation = 0;
    let refreshing;
    const { http, query, platform, sessions } = client;
    const clean = () => { for (const [key, value] of pending) if (value.expires <= Date.now()) pending.delete(key); };
    // Attach a safe stage name; neither credentials nor an account's raw response enter diagnostics.
    const step = async (stage, run) => {
        try { return await run(); }
        catch (error) {
            const failure = error instanceof QishuiError ? error : new QishuiError('invalid-response', 'Qishui sign-in response could not be read', undefined, { cause: error });
            failure.stage ||= stage;
            throw failure;
        }
    };
    const getUser = credential => step('account', async () => {
        const { my_info: user } = await platform('/me/info/', {}, credential);
        if (!isAccountId(user?.id)) throw new QishuiError('invalid-response', 'Qishui did not identify the account');
        return { id: String(user.id), nickname: String(user.nickname || ''),
            avatar: user.medium_avatar_url || user.avatar_url || user.thumb_avatar_url, isVip: user.is_vip === true };
    });
    async function ticket(access, guard, deviceId) {
        if (!access.access_code) throw new QishuiError('invalid-response', 'Access code is missing');
        const response = await http(`https://open-client.douyin.com/passport/open/get_access_ticket/?${new URLSearchParams({ aid: '1128', client_key: CLIENT_KEY, device_platform: 'android' })}`, {
            body: { access_code: access.access_code, open_id: String(access.open_id || access.open_uid || '') }, form: true,
            headers: { 'bd-ticket-guard-version': '1', ...(guard.csr ? { 'bd-ticket-guard-client-csr': guard.csr } : { 'bd-ticket-guard-client-cert': guard.guardCert }) },
        });
        return { deviceId, guardKey: guard.guardKey, ...readQishuiGuard(response.headers.get('bd-ticket-guard-server-data')),
            accessCode: access.access_code, openId: String(access.open_id || access.open_uid || ''), expiresAt: qishuiCredentialExpiry(access.expires_time).getTime() };
    }
    async function renew() {
        const old = sessions.get();
        if (!old) return null;
        const revision = sessions.revision;
        let candidate = old;
        if (old.expiresAt < Date.now() + 3600000) {
            const result = await http(query(`https://open.qishui.com${PREFIX}/access/code/refresh/`, { access_code: old.accessCode }, old.deviceId));
            const access = result.data.data || result.data;
            candidate = await ticket({ ...access, open_id: access.open_id || access.open_uid || old.openId }, old, old.deviceId);
        }
        const user = await getUser(candidate);
        if (user.id !== old.userId) throw new QishuiError('auth-required', 'Qishui account identity changed');
        if (revision !== sessions.revision) return null;
        sessions.set({ ...candidate, userId: user.id, user });
        return user;
    }
    return {
        async start() {
            clean(); pending.clear();
            const mine = ++generation;
            const result = await http(`https://open.douyin.com/oauth/get_qrcode/?${new URLSearchParams(qrParams())}`);
            const data = result.data.data;
            if (!data?.token || !data.qrcode) throw new QishuiError('invalid-response', 'QR code is missing');
            if (mine !== generation) throw new QishuiError('unavailable', 'Sign-in was cancelled');
            const key = crypto.randomBytes(16).toString('hex');
            pending.set(key, { token: data.token, qr: `data:image/png;base64,${data.qrcode}`, expires: Date.now() + 300000 });
            log('[Qishui] Sign-in QR created');
            return { key };
        },
        qr(key) { clean(); const value = pending.get(key); if (!value) throw new QishuiError('unavailable', 'QR session expired'); return { imageUrl: value.qr }; },
        async check(key) {
            clean();
            const value = pending.get(key);
            if (!value) return { state: 'expired' };
            if (value.task) return value.task;
            const revision = sessions.revision;
            const run = async () => {
                const result = await http(`https://open.douyin.com/oauth/check_qrcode/?${new URLSearchParams({ ...qrParams(), token: value.token, timestamp: String(Date.now()) })}`);
                const data = result.data.data;
                if (!data || !['new', 'scanned', 'confirmed', 'expired', 'refused'].includes(data.status)) throw new QishuiError('invalid-response', 'Invalid QR status');
                if (data.status !== 'confirmed') {
                    if (['expired', 'refused'].includes(data.status)) pending.delete(key);
                    return data.status === 'refused' ? { state: 'error', failure: { case: 'refused' } } : { state: data.status === 'new' ? 'waiting' : data.status };
                }
                const code = data.code || data.auth_code;
                if (!code) throw new QishuiError('invalid-response', 'QR authorization code is missing');
                const access = await step('access-code', () => http(query(`https://open.qishui.com${PREFIX}/access/code/get/`, { auth_code: code })));
                const credential = await step('ticket', () => ticket(access.data.data || access.data, createQishuiGuard(), sessions.deviceId));
                const user = await getUser(credential);
                if (pending.get(key) !== value || sessions.revision !== revision) return { state: 'expired' };
                sessions.set({ ...credential, userId: user.id, user });
                pending.delete(key);
                log('[Qishui] Sign-in confirmed; account stored');
                return { state: 'confirmed' };
            };
            value.task = run().finally(() => { value.task = undefined; });
            return value.task;
        },
        cancel(key) { pending.delete(key); },
        logout() { generation++; pending.clear(); sessions.clear(); log('[Qishui] Signed out'); },
        status() {
            if (!refreshing) refreshing = renew().finally(() => { refreshing = undefined; });
            return refreshing;
        },
    };
}
module.exports = { createAuth };
