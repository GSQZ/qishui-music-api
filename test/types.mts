import { createQishuiApi, createQishuiDeviceId, isQishuiDeviceId, QISHUI_OPERATIONS } from '../index.cjs';
import type { QishuiSession, QishuiBridgeResult, QishuiOperation, QishuiParams } from '../index.cjs';

// Compile the exported contract as an external ESM consumer, without Electron or application types.
let session: QishuiSession | null = null;
let revision = 0;
const deviceId = createQishuiDeviceId();
const api = createQishuiApi({ deviceId, fetch: globalThis.fetch, sessions: {
    deviceId, get revision() { return revision; }, get: () => session,
    set: value => { session = value; revision++; }, clear: () => { session = null; revision++; },
} });
const operation: QishuiOperation = QISHUI_OPERATIONS[0];
const params: QishuiParams = { id: '123', limit: 20 };
const result: Promise<QishuiBridgeResult> = api.request(operation, params);
const valid: boolean = isQishuiDeviceId(deviceId);
void result;
void valid;
// @ts-expect-error Arbitrary network operations are not part of the API.
api.request('fetch');
