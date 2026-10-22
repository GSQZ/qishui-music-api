import { createQishuiApi, createQishuiDeviceId, isQishuiDeviceId, QISHUI_OPERATIONS } from '../index.cjs';
import type { QishuiSession, QishuiBridgeResult, QishuiOperation, QishuiParams, QishuiAudioSource, QishuiTrackCheck } from '../index.cjs';

// Compile the exported contract as an external ESM consumer, without Electron or application types.
let session: QishuiSession | null = null;
let revision = 0;
const deviceId = createQishuiDeviceId();
const api = createQishuiApi({ deviceId, fetch: globalThis.fetch, warn: message => void message, sessions: {
    deviceId, get revision() { return revision; }, get: () => session,
    set: value => { session = value; revision++; }, clear: () => { session = null; revision++; },
} });
const operation: QishuiOperation = QISHUI_OPERATIONS[0];
const params: QishuiParams = { id: '123', limit: 20 };
const result: Promise<QishuiBridgeResult> = api.request(operation, params);
const valid: boolean = isQishuiDeviceId(deviceId);
const accountOperations: QishuiOperation[] = ['liked_songs', 'like_song', 'playlist_add_tracks',
    'playlist_remove_tracks', 'recent_played', 'check_tracks', 'dislike_song'];
const source: QishuiAudioSource = { url: 'https://example.test/a', quality: 'standard', fetchedAt: 1, preview: true, clipStartMs: 1000 };
const check: QishuiTrackCheck = { id: '1', riskResult: 0, status: 0 };
void result;
void valid;
void accountOperations;
void source;
void check;
// @ts-expect-error Arbitrary network operations are not part of the API.
api.request('fetch');
