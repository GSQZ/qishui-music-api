const { createPrivateKey, generateKeyPairSync, randomBytes, sign } = require('node:crypto');

// Car ticket-guard authorization protocol; see ../LICENSE.
const isAccountId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\s\x00-\x1f\x7f]/u.test(value);
const isQishuiDeviceId = value => typeof value === 'string' && /^\d{19}$/.test(value);
const createQishuiDeviceId = () => (randomBytes(8).readBigUInt64BE() % 9000000000000000000n + 1000000000000000000n).toString();
const QISHUI_UA = 'LunaOpenSDK/1.0.10';
const QISHUI_PREFIX = '/api/luna/v1/platform';
const QISHUI_CLIENT_KEY = 'aw4bbxfujo741d09';
const QISHUI_COMMON = {
    aid: '765213',
    app_id: '765213',
    app_name: 'byte_autoservice_lite',
    version_code: '100010',
    version_name: '1.0.10',
    channel: 'bydSong',
    sdk_aid: '753999',
    caller_name: 'luna_open_sdk',
    sdk_version_code: '100000100',
    sdk_version_name: '0.0.1',
    sdk_channel: 'Test',
    vehicle_type: 'BYD',
    device_brand: 'BYD',
    device_type: 'BYD',
    device_platform: 'android',
    resolution: '1920x1080',
    os_version: '13',
    ac: 'wifi'
};
function qishuiParams(deviceId) {
    return new URLSearchParams({
        ...QISHUI_COMMON,
        device_id: deviceId,
        did: deviceId,
        iid: deviceId,
        vehicle_id: `qishui-${deviceId}`,
        _timestamp: String(Math.floor(Date.now() / 1000)),
        _nonce: String(randomBytes(2).readUInt16BE())
    }).toString();
}
function der(tag, ...values) {
    const value = Buffer.concat(values);
    const length = value.length < 128 ? Buffer.from([value.length])
        : value.length < 256 ? Buffer.from([0x81, value.length])
            : Buffer.from([0x82, value.length >> 8, value.length & 255]);
    return Buffer.concat([Buffer.from([tag]), length, value]);
}
// Generate a fresh P-256 key and PKCS#10 request for this Folia authorization, not a client's saved identity.
function createQishuiGuard() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
        namedCurve: 'prime256v1'
    });
    const subject = der(0x30, ...[[3, 'bd-ticket-guard'], [11, ''], [10, '']].map(([id, value]) => (
        der(0x31, der(0x30, der(6, Buffer.from([0x55, 4, Number(id)])), der(12, Buffer.from(String(value)))))
    )));
    const info = der(0x30, der(2, Buffer.from([0])), subject, publicKey.export({
        type: 'spki',
        format: 'der'
    }), der(0xa0));
    const algorithm = der(0x30, der(6, Buffer.from('2a8648ce3d040302', 'hex')));
    const request = der(0x30, info, algorithm, der(3, Buffer.from([0]), sign('sha256', info, privateKey)));
    const pem = `-----BEGIN CERTIFICATE REQUEST-----\n${request.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE REQUEST-----\n`;
    return {
        guardKey: privateKey.export({
            type: 'pkcs8',
            format: 'pem'
        }).toString(),
        csr: Buffer.from(pem).toString('base64')
    };
}
function qishuiGuardHeaders(credential, path = '/me/info/') {
    for (const key of ['ticket', 'guardKey', 'guardCert', 'guardTsSign']) {
        if (typeof credential[key] !== 'string' || !credential[key] || credential[key].length > 16_384) {
            throw new Error('invalid guard credential');
        }
    }
    const key = createPrivateKey(credential.guardKey);
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
        throw new Error('invalid guard key');
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const content = `ticket=${credential.ticket}&path=${QISHUI_PREFIX}${path}&timestamp=${timestamp}`;
    return {
        'access-token': credential.ticket,
        'bd-ticket-guard-version': '1',
        'bd-ticket-guard-client-cert': credential.guardCert,
        'bd-ticket-guard-client-data': Buffer.from(JSON.stringify({
            ts_sign: credential.guardTsSign,
            req_content: 'ticket,path,timestamp',
            req_sign: sign('sha256', Buffer.from(content), key).toString('base64'),
            timestamp
        })).toString('base64')
    };
}
function readQishuiGuard(raw) {
    if (typeof raw !== 'string' || !raw || raw.length > 65536) throw new Error('invalid guard response');
    const data = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    for (const key of ['ticket', 'ts_sign', 'client_cert']) {
        if (typeof data[key] !== 'string' || !data[key] || data[key].length > 16384) throw new Error('invalid guard response');
    }
    const cert = data.client_cert;
    return {
        ticket: data.ticket,
        guardTsSign: data.ts_sign,
        guardCert: cert.includes('-----BEGIN') ? Buffer.from(cert).toString('base64') : cert
    };
}
function qishuiCredentialExpiry(raw) {
    const value = Number(raw || 0);
    const expires = value > 1e12 ? value : value > 1e9 ? value * 1000 : value > 0 ? Date.now() + value * 1000 : Date.now() + 6 * 3600000;
    if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error('invalid credential expiry');
    return new Date(expires);
}

module.exports = { isAccountId, isQishuiDeviceId, createQishuiDeviceId, QISHUI_UA, QISHUI_PREFIX, QISHUI_CLIENT_KEY, QISHUI_COMMON, qishuiParams, createQishuiGuard, qishuiGuardHeaders, readQishuiGuard, qishuiCredentialExpiry };
