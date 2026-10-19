# qishui-music-api

汽水音乐车机协议的 Node.js 客户端，供服务端或 Electron 主进程调用。支持用户主动发起的抖音扫码授权、账号恢复、搜索、歌词、歌单读取、歌手热门歌曲、推荐流和场景电台。

## 安装

```sh
npm install --save-exact qishui-music-api@0.1.0
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

`request` 返回 `{ ok: true, data }` 或 `{ ok: false, error: { code, message, upstreamCode?, stage? } }`。操作名由只读的 `QISHUI_OPERATIONS` 导出；TypeScript 类型与入口一起发布。设备 ID 必须由 `createQishuiDeviceId()` 生成，恢复时用 `isQishuiDeviceId()` 校验。

`sessions.get/set/clear` 都是同步方法，每次写入或清除都要增加 `revision`。宿主负责存储、加密和 IPC 白名单；包不读写磁盘、不导入 Electron，也不开本地服务。`fetch` 可替换为 Electron 的 `net.fetch`。会话只允许在可信主进程内使用，不要将 ticket、私钥或原始会话交给网页，也不要记录会话内容。

包只使用用户在调用方主动扫码授权的会话，不读取其他应用的凭据，不加载官方客户端原生模块或依赖泄漏源码。播放只选择接口返回的未加密资源；只有受保护音频时会返回错误，不解密音频、不提取音频密钥。返回的试听资源保留 `preview` 标记。平台不支持的收藏写入、歌单编辑等操作不提供。

## 开发

需要 Node.js 24 或更新版本：`npm ci`、`npm run typecheck`、`npm test`。测试使用合成响应和注入的传输，不访问真实账号；测试通过不能保证上游接口永久可用。发布前执行 `npm pack --dry-run` 检查文件清单，发布使用 npm Registry 的正式版本。

MIT License。源码和测试在 [GSQZ/qishui-music-api](https://github.com/GSQZ/qishui-music-api) 独立维护。
