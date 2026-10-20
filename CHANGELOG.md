# Changelog

## Unreleased

- 喜欢列表缺少必要字段、查找游标停滞或达到查找页数上限时返回错误，避免将未完成的读取当成完整空列表。
- 最近播放的 `hasMore` 同时考虑当前上游页中尚未返回的歌曲，保留末页剩余条目的翻页能力。

## 0.2.0

- 新增车机账号能力：`liked_songs`、`like_song`、`playlist_add_tracks`、`playlist_remove_tracks`、`recent_played`、`check_tracks`、`dislike_song`。
- 试听资源在车机返回片段起点时附带 `clipStartMs`，并导出 `QishuiAudioSource` / `QishuiTrackCheck` 类型。
- 车机 `access_token` 过期（`28001008`）按 `auth-required` 返回，宿主可据此重新扫码。
- 明确车机协议边界：不提供专辑详情、新建歌单、收藏歌单/专辑，也不解密受保护音质。

## 0.1.0

- 独立维护车机协议、扫码授权、目录分页、推荐流和未加密音频地址选择。
- 导出固定操作表、宿主注入的会话接口、设备标识函数和 TypeScript 类型。
- 无运行时依赖；宿主保留持久化、凭据加密和媒体跨域处理。
