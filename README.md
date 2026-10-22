# qishui-music-api

汽水音乐车机协议的 Node.js 客户端，供服务端或 Electron 主进程调用。支持用户主动发起的抖音扫码授权、账号恢复、搜索、歌词、歌单读取、歌手热门歌曲、推荐流和场景电台，以及车机接口覆盖的喜欢、歌单加歌/删歌、最近播放、可播性检查和推荐"不感兴趣"。

## 安装

```sh
npm install --save-exact qishui-music-api@0.2.1
```

## 使用

```js
const { createQishuiApi, createQishuiDeviceId } = require('qishui-music-api');

const deviceId = createQishuiDeviceId(); // 生成一次，由宿主保存并复用
let current = null;
let revision = 0;
const sessions = {
    deviceId,
    get revision() { return revision; },
    get: () => current,
    set(value) { current = value; revision++; },
    clear() { current = null; revision++; },
};
const api = createQishuiApi({ deviceId, sessions, fetch: globalThis.fetch });
const result = await api.request('search', { query: '晴天', limit: 20, offset: 0 });
```

`request` 返回 `{ ok: true, data }` 或 `{ ok: false, error: { code, message, upstreamCode?, stage? } }`。操作名由只读的 `QISHUI_OPERATIONS` 导出；TypeScript 类型与入口一起发布。设备 ID 必须由 `createQishuiDeviceId()` 生成，恢复时用 `isQishuiDeviceId()` 校验。推荐流 `feed` 接受 `scene`（`feed_modes` 返回的场景 ID）或 `preference`（小写的偏好模式名，如 `familiar`、`fresh`），两者互斥，格式不对时在请求前返回 `invalid-response`。

账号读取与写入操作：`liked_songs`、`like_song`（`{ id, liked }`）、`playlist_add_tracks` / `playlist_remove_tracks`（`{ id, ids }`，单次最多 100 首）、`recent_played`、`check_tracks`（`{ ids }`）、`dislike_song`（`{ id, disliked }`）。写操作与账号读取需要已登录会话；车机接口没有专辑详情、新建歌单、收藏歌单/专辑的端点，这些操作不提供。

`sessions.get/set/clear` 都是同步方法，每次写入或清除都要增加 `revision`。宿主负责存储、加密和 IPC 白名单；包不读写磁盘、不导入 Electron，也不开本地服务。`fetch` 可替换为 Electron 的 `net.fetch`。`log` / `warn`（可选，`warn` 未注入时用 `log`）只接收不含地址和凭据的诊断文本，例如被拒的媒体主机名。会话只允许在可信主进程内使用，不要将 ticket、私钥或原始会话交给网页，也不要记录会话内容。

公共读取使用独立于账号 ticket-guard 的客户端令牌。已知读取端点收到明确的令牌过期错误 `28001008` 时，会丢弃该代令牌、合并并发刷新，并最多重试一次；不会据此清除账号或要求重新扫码，也不假定令牌的固定有效期。刷新失败会返回错误，后续独立请求可重新获取；一般网络/HTTP 错误不会触发令牌刷新。账号读取和喜欢、歌单编辑、不感兴趣等写入使用 ticket-guard，失败时不会套用公共令牌恢复，也不会自动重放写操作。`login_status` 续期时只使用账号自己的凭据：access code 刷新、ticket 交换或 `/me/info/` 以明确的鉴权错误码（`28001003`、`28001007`、`28001008`、`10007`）拒绝，或续期后账号身份变了，包会调用 `sessions.clear()`，宿主据此要求重新扫码；没有平台错误码的 HTTP 401/403、网络和解析失败，以及续期期间宿主已经换过的会话，都不会被清除。

包只使用用户在调用方主动扫码授权的会话，不读取其他应用的凭据，不加载官方客户端原生模块或依赖泄漏源码。播放只选择接口返回的未加密资源；只有受保护音频时返回错误，不解密音频、不提取音频密钥（因此车机接口的 `higher` / `highest` / `lossless` 档位无法提供，只提供未加密的 `standard`）。返回的试听资源保留 `preview` 标记，车机给出片段起点时一并返回 `clipStartMs`（类型 `QishuiAudioSource`）。

## 开发

需要 Node.js 24 或更新版本：`npm ci`、`npm run typecheck`、`npm test`。测试使用合成响应和注入的传输，不访问真实账号；测试通过不能保证上游接口永久可用。发布前执行 `npm pack --dry-run` 检查文件清单，发布使用 npm Registry 的正式版本。

MIT License。源码和测试在 [GSQZ/qishui-music-api](https://github.com/GSQZ/qishui-music-api) 独立维护。
