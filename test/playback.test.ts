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
        expect(result).not.toHaveProperty('clipStartMs');
    });
    it('reports where a preview clip starts inside the song', async () => {
        const track = { player_info: { preview: { duration: { start_ms: 208320, duration_ms: 60001 },
            video_model_info: { url_player_info: vod } } } };
        const result = await resolveAudio({ http: async () => ({ data: { PlayInfoList: [{ MainPlayUrl: audio }] } }) }, track, 'standard');
        expect(result).toMatchObject({ preview: true, clipStartMs: 208320 });
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
        await expect(resolveAudio({ http: async () => ({ data: { PlayInfoList: [{ MainPlayUrl: 'https://127.0.0.1/private' }] } }), warn: vi.fn() }, info(), 'standard'))
            .rejects.toMatchObject({ code: 'invalid-response' });
    });
});
describe('Qishui media host trust', () => {
    // Observed answer shape: the model URL and both VOD play URLs on v3-dy-o.zjcdn.com.
    const zjcdn = 'https://v3-dy-o.zjcdn.com/0123abcd/audio.m4a?a=6589&sign=fixture-signature';
    const model = (...urls: string[]) => ({ player_info: { full: { video_model_info: { video_model: JSON.stringify({
        video_list: urls.map((main_url, index) => ({ main_url, video_meta: { quality: 'medium', bitrate: 1000 - index } })),
    }) } } } });
    it('plays plaintext audio from the Douyin zjcdn media CDN', async () => {
        const http = vi.fn(async () => ({ data: { Result: { Data: { PlayInfoList: [
            { MainPlayUrl: zjcdn, BackupPlayUrl: zjcdn, Quality: 'medium' },
        ] } } } }));
        await expect(resolveAudio({ http }, model(zjcdn), 'standard')).resolves.toMatchObject({ url: zjcdn, preview: false });
        await expect(resolveAudio({ http }, info(), 'standard')).resolves.toMatchObject({ url: zjcdn });
    });
    it('skips an untrusted candidate and reports only its host name', async () => {
        const warn = vi.fn();
        const http = vi.fn();
        const result = await resolveAudio({ http, warn }, model('https://cdn.unknown.test/path/a.m4a?sign=fixture-signature', audio), 'standard');
        expect(result.url).toBe(audio);
        expect(http).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('cdn.unknown.test');
        expect(warn.mock.calls[0][0]).not.toMatch(/path|sign|fixture-signature/);
    });
    it('follows the VOD route when every model candidate is untrusted', async () => {
        const warn = vi.fn();
        const track = model('https://cdn.unknown.test/a');
        track.player_info.full.video_model_info = { ...track.player_info.full.video_model_info, url_player_info: vod } as any;
        const http = vi.fn(async () => ({ data: { PlayInfoList: [{ MainPlayUrl: audio }] } }));
        await expect(resolveAudio({ http, warn }, track, 'standard')).resolves.toMatchObject({ url: audio });
        expect(http).toHaveBeenCalledWith(vod);
        expect(warn.mock.calls[0][0]).toContain('cdn.unknown.test');
    });
    it('fails only when every plaintext candidate is untrusted, without falling back to a preview', async () => {
        const warn = vi.fn();
        const http = vi.fn(async () => ({ data: { PlayInfoList: [
            { MainPlayUrl: 'https://a.unknown.test/x?sign=1' }, { MainPlayUrl: 'http://v26-default.365yg.com/audio' },
        ] } }));
        const track = { player_info: { full: { video_model_info: { url_player_info: vod } },
            preview: { video_model_info: { video_model: { video_list: [{ main_url: audio }] } } } } };
        await expect(resolveAudio({ http, warn }, track, 'standard')).rejects.toMatchObject({ code: 'invalid-response', message: 'Untrusted Qishui media host' });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('a.unknown.test');
        expect(warn.mock.calls[0][0]).toContain('v26-default.365yg.com');
        expect(warn.mock.calls[0][0]).not.toContain('sign');
    });
    it('does not request an untrusted VOD play-info address', async () => {
        const warn = vi.fn();
        const http = vi.fn();
        const track = { player_info: { full: { video_model_info: { url_player_info: 'https://vod.unknown.test/playinfo?token=fixture-private' } } } };
        await expect(resolveAudio({ http, warn }, track, 'standard')).rejects.toMatchObject({ code: 'invalid-response' });
        expect(http).not.toHaveBeenCalled();
        expect(warn.mock.calls[0][0]).toContain('vod.unknown.test');
        expect(warn.mock.calls[0][0]).not.toContain('fixture-private');
    });
});
