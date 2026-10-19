import { createRequire } from 'node:module';
import { describe, it, expect, vi } from 'vitest';

// The plaintext-only path never decrypts a protected model or promotes a preview to a whole song.
const { resolveAudio } = createRequire(import.meta.url)('../src/playback.cjs');
const vod = 'https://vod-luna.douyin.com/playinfo';
const audio = 'https://v26-default.365yg.com/audio';
const info = (preview = false) => ({ player_info: { [preview ? 'preview' : 'full']: { video_model_info: { url_player_info: vod } } } });
describe('Qishui plaintext playback', () => {
    it('uses the VOD plaintext route without returning encryption material', async () => {
        const http = vi.fn(async () => ({ data: { Result: { Data: { PlayInfoList: [{ MainPlayUrl: audio, Quality: 'medium' }] } } } }));
        const issued = vi.fn();
        const result = await resolveAudio({ http }, info(), 'standard', issued);
        expect(result).toMatchObject({ url: audio, quality: 'standard', preview: false });
        expect(issued).toHaveBeenCalledWith(audio);
        expect(http).toHaveBeenCalledWith(vod);
    });
    it('marks a preview resource so Folia will show its notice and avoid caching it as a song', async () => {
        const result = await resolveAudio({ http: async () => ({ data: { PlayInfoList: [{ MainPlayUrl: audio }] } }) }, info(true), 'standard');
        expect(result.preview).toBe(true);
    });
    it('rejects protected-only audio even when a model contains a downloadable URL', async () => {
        const protectedTrack = { player_info: { full: { video_model_info: { video_model: JSON.stringify({ video_list: [
            { main_url: audio, encrypt_info: { encrypt: true, spade_a: 'not-a-real-key' } },
        ] }) } } } };
        const http = vi.fn();
        await expect(resolveAudio({ http }, protectedTrack, 'standard')).rejects.toMatchObject({ code: 'unsupported' });
        expect(http).not.toHaveBeenCalled();
    });
    it('rejects protected VOD answers and credential-bearing or arbitrary resource URLs', async () => {
        await expect(resolveAudio({ http: async () => ({ data: { PlayInfoList: [{ MainPlayUrl: audio, PlayAuth: 'protected' }] } }) }, info(), 'standard'))
            .rejects.toMatchObject({ code: 'unsupported' });
        await expect(resolveAudio({ http: async () => ({ data: { PlayInfoList: [{ MainPlayUrl: 'https://127.0.0.1/private' }] } }) }, info(), 'standard'))
            .rejects.toMatchObject({ code: 'invalid-response' });
    });
});
