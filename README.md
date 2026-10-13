# M2M

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020.svg)](https://workers.cloudflare.com/)

M2M is a Cloudflare Workers app for migrating public playlists from Chinese music platforms to Apple Music.

Live demo: https://m2m.xinyu017722.workers.dev/

Changelog: [CHANGELOG.md](CHANGELOG.md)

Languages: [English](#english) | [简体中文](#简体中文)

## English

### Overview

M2M reads a public playlist link, extracts track metadata, lets the user authorize Apple Music in the browser, then creates an Apple Music library playlist and imports matched tracks.

The project is designed as a public web service:

- No account system.
- No server-side storage of Apple ID data.
- User-level Apple Music authorization stays in the browser.
- Server-side parsing is protected by a lightweight queue.
- The app can be deployed on Cloudflare Workers and Durable Objects.

### Supported Sources

| Source | Supported links | Notes |
| --- | --- | --- |
| NetEase Cloud Music | `music.163.com`, `y.music.163.com`, `163cn.tv` | Playlist pages and short links |
| QQ Music | `y.qq.com` | Playlist URLs with `id` or `disstid` |
| Kugou Music | `m.kugou.com/songlist/...`, `www.kugou.com/songlist/...`, `t*.kugou.com` | Some public share pages expose preview tracks only |
| Kuwo Music | `m.kuwo.cn`, `www.kuwo.cn` | Playlist detail pages |

When a source only exposes partial tracks, the API response is marked with `limited: true`.

### Features

- Detects the playlist source automatically.
- Extracts playlist name, cover, creator, track order, title, artists, album, and duration.
- Streams parsing progress with Server-Sent Events.
- Uses a Worker-side queue to protect free-tier resources.
- Shows queue position and estimated wait time in the UI.
- Authorizes Apple Music with MusicKit JS in the browser.
- Creates a new Apple Music playlist with a user-provided name.
- Searches the Apple Music catalog by title, artist, and album.
- Preserves source aliases and normalizes Unicode metadata for multilingual matching.
- Uses Japanese, Korean, or Russian catalogs to identify translated recordings, then resolves their ISRCs in the subscriber's catalog.
- Coordinates catalog searches globally, shares cached results, and deduplicates concurrent queries.
- Imports matched tracks in batches.
- Shows success count, failure count, total progress, and failed track details.
- Exports parsed playlist data as JSON.

### How It Works

1. The user opens the web app.
2. The user pastes a supported public playlist URL.
3. The browser joins the Worker-side queue.
4. The Worker parses the playlist and streams progress events.
5. The UI displays parsed tracks for review.
6. The user connects Apple Music.
7. MusicKit JS completes Apple ID authorization in the browser.
8. M2M creates an Apple Music playlist.
9. Tracks are searched, matched, and imported.
10. The UI displays import results and failed tracks.

### Architecture

- `src/index.js`: Cloudflare Worker entry, routing, CORS, API responses, and Apple token endpoint.
- `src/frontend.js`: Browser UI, queue flow, MusicKit integration, matching, and import progress.
- `src/playlist.js`: Multi-platform playlist source detection and parsing.
- `src/netease.js`: NetEase playlist parser.
- `src/apple.js`: Apple Music Developer Token generation.
- `src/matching.js`: Shared multilingual matching and recording/version checks.
- `src/apple-catalog.js`: Public catalog cache, global request scheduling, and Apple rate-limit handling.
- `src/queue.js`: Durable Object queue coordinator.
- `test/*.test.js`: Node.js test suites.

### Privacy Model

M2M does not store user accounts, Apple IDs, Apple Music user tokens, or personal music library data on the server.

The backend only handles:

- Public playlist parsing.
- Temporary queue state.
- Site-level Apple Music Developer Token generation.
- Public Apple Music catalog searches and temporary in-memory caching of catalog results.

Apple Music user authorization is handled by MusicKit JS in the browser. Requests that modify the user's Apple Music library use the browser-side Music User Token.

Catalog requests contain a region and public track metadata, never a Music User Token. The shared cache holds up to 500 queries, with a six-hour TTL for results and five minutes for empty results. It is not persisted to Durable Object storage and can be cleared when the instance restarts. Playlist creation and library writes remain browser-to-Apple requests.

### Apple Music Authentication

Apple Music requires two token layers:

- Developer Token: site-level token identifying this web app.
- Music User Token: user-level token created by MusicKit JS after Apple ID authorization.

End users do not need Apple Developer credentials. The deployer must configure the site-level Apple Music API credentials.

Supported Worker configurations:

| Variable | Required | Description |
| --- | --- | --- |
| `APPLE_TEAM_ID` | For automatic signing | Apple Developer Team ID |
| `APPLE_KEY_ID` | For automatic signing | Apple Music API key ID |
| `APPLE_PRIVATE_KEY` | For automatic signing | Apple Music API `.p8` private key content |
| `APPLE_DEVELOPER_TOKEN` | Optional alternative | Pre-signed Developer Token |
| `APPLE_TOKEN_TTL_SECONDS` | Optional | Token TTL, defaults to `43200` |

Use either automatic signing or a pre-signed developer token. Do not commit `.p8`, `.dev.vars`, or any real token to Git.

### API

#### `GET /playlist`

Parse a supported public playlist URL.

Query parameters:

- `url`: playlist URL.
- `limit`: optional track limit for testing.

Example:

```sh
curl "https://m2m.xinyu017722.workers.dev/playlist?url=https%3A%2F%2F163cn.tv%2F8kPnBRH"
```

Example response:

```json
{
  "sourceUrl": "https://163cn.tv/8kPnBRH",
  "resolvedUrl": "https://music.163.com/playlist?id=486271477",
  "source": {
    "key": "netease",
    "name": "网易云音乐"
  },
  "playlist": {
    "id": 486271477,
    "name": "Playlist name",
    "trackCount": 1501
  },
  "extractedCount": 1501,
  "missingCount": 0,
  "limited": false,
  "tracks": [
    {
      "index": 1,
      "id": 2744403189,
      "name": "Track title",
      "artists": ["Artist name"],
      "album": "Album name",
      "durationMs": 235356
    }
  ]
}
```

#### `POST /playlist`

Parse a playlist URL with a JSON request body.

```json
{
  "url": "https://163cn.tv/8kPnBRH",
  "limit": 50
}
```

#### `POST /playlist/stream`

Streams parser progress with Server-Sent Events. The browser uses this endpoint so playlist URLs and queue tickets are not placed in the request URL.

Events:

- `progress`: parsing progress.
- `done`: final playlist payload.
- `app-error`: normalized error payload.

Legacy aliases are still available:

- `POST /netease/playlist`
- `POST /netease/playlist/stream`

#### `GET /apple/developer-token`

Returns an Apple Music Developer Token for MusicKit JS.

#### `POST /apple/catalog`

Searches public catalog songs or resolves recordings by ISRC through the shared coordinator. Requests accept either `{ "action": "search", "storefront": "cn", "term": "song artist", "limit": 25 }` or `{ "action": "isrc", "storefront": "cn", "isrcs": ["JPWP01671360"] }`. The response contains `data` and `cacheHit`. No subscriber credentials are required or forwarded.

Invalid requests are rejected. Temporary errors include `error.details.retryAfterMs`, and the frontend respects the full delay. After repeated temporary failures, the import pauses without counting the current track as missing.

### Local Development

```sh
npm install
npm test
npm run dev
```

The Wrangler configuration sets `keep_names = false` so the shared matcher embedded in the browser remains self-contained after bundling. The bundle regression test checks this using the deployment configuration.

Test the parser locally:

```sh
curl "http://localhost:8787/playlist?url=https%3A%2F%2F163cn.tv%2F8kPnBRH&limit=10"
```

For local Apple Music import testing, create `.dev.vars`:

```sh
APPLE_TEAM_ID=YOUR_TEAM_ID
APPLE_KEY_ID=YOUR_KEY_ID
APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----"
```

Or use a pre-signed developer token:

```sh
APPLE_DEVELOPER_TOKEN=YOUR_PRE_SIGNED_DEVELOPER_TOKEN
```

Generate a pre-signed token:

```sh
npm run --silent apple:token -- \
  --team-id YOUR_APPLE_TEAM_ID \
  --private-key ~/share/AuthKey_<KEY_ID>.p8
```

Inspect token metadata:

```sh
npm run --silent apple:token -- \
  --team-id YOUR_APPLE_TEAM_ID \
  --private-key ~/share/AuthKey_<KEY_ID>.p8 \
  --json
```

### Deployment

#### GitHub Actions

The repository includes `.github/workflows/deploy-worker.yml`.

1. Create a Cloudflare API token with Workers deployment permissions.
2. Find your Cloudflare Account ID.
3. Add GitHub repository secrets:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
4. Push to `main`, or run the workflow manually.

Configure Apple Music secrets in Cloudflare Workers:

```sh
npx wrangler secret put APPLE_TEAM_ID
npx wrangler secret put APPLE_KEY_ID
npx wrangler secret put APPLE_PRIVATE_KEY
```

Or configure a pre-signed token:

```sh
npx wrangler secret put APPLE_DEVELOPER_TOKEN
```

Check the deployment:

```sh
curl https://m2m.xinyu017722.workers.dev/health
```

`appleConfigured` should be `true`.

#### Cloudflare Git Integration

You can also connect the GitHub repository `cunyu-wxy/M2M` in the Cloudflare dashboard.

Recommended settings:

- Build command: `npm install && npm test`
- Deploy command: `npx wrangler deploy`
- Worker entry: `src/index.js`

### Worker Limits

Current `wrangler.toml` defaults:

- `PLAYLIST_MAX_TRACKS=2000`
- `NETEASE_MAX_TRACKS=2000`
- `NETEASE_BATCH_SIZE=200`
- `QUEUE_MAX_ACTIVE=2`
- `APPLE_SEARCH_INTERVAL_MS=250`: minimum time between uncached Apple catalog request starts, shared across users. At most two upstream requests run concurrently.

The existing `M2M_QUEUE` Durable Object also coordinates catalog requests; no additional binding or migration is required. Without that binding, local development uses a per-Worker-instance coordinator, which is not a global production rate limit.

Raise these limits only after validating queue behavior, upstream rate limits, and Apple Music import retries.

### Limitations

- Apple Music search may return wrong versions for covers, remixes, same-name tracks, or region-limited songs.
- Apple Music API rate limits can affect large imports.
- Requests cannot bypass Apple's developer-token quota. Cold searches and cross-language fallbacks take longer than cache hits; throughput is not guaranteed.
- Native-language catalog lookups never authorize importing songs unavailable in the subscriber's region. ISRC availability and source metadata quality still limit matches.
- Upstream music platform page structures may change.
- Some Kugou share pages expose preview tracks only.

### Roadmap

- Improve Apple Music match scoring and retry behavior.
- Add richer import pause/resume controls.
- Add more source-specific parsers and fallback strategies.
- Improve large-playlist throughput while respecting upstream limits.

### Contributing

Issues and pull requests are welcome. Useful reports include:

- Playlist links that fail to parse.
- Tracks that match incorrectly in Apple Music.
- Source platform page changes.
- UI or accessibility improvements.

### License

M2M is released under the [MIT License](LICENSE).

## 简体中文

### 项目简介

M2M 是一个部署在 Cloudflare Workers 上的在线歌单迁移工具，用来把中文音乐平台的公开歌单解析出来，并迁移到用户自己的 Apple Music 资料库。

在线体验：https://m2m.xinyu017722.workers.dev/

这个项目按公共服务设计：

- 不做账号系统。
- 后端不保存 Apple ID 数据。
- 用户级 Apple Music 授权留在浏览器内完成。
- 服务端解析任务由轻量队列保护。
- 可以部署在 Cloudflare Workers 和 Durable Objects 上。

### 支持平台

| 平台 | 支持链接 | 说明 |
| --- | --- | --- |
| 网易云音乐 | `music.163.com`、`y.music.163.com`、`163cn.tv` | 支持歌单页和短链接 |
| QQ 音乐 | `y.qq.com` | 支持带 `id` 或 `disstid` 的歌单链接 |
| 酷狗音乐 | `m.kugou.com/songlist/...`、`www.kugou.com/songlist/...`、`t*.kugou.com` | 部分公开分享页只暴露预览曲目 |
| 酷我音乐 | `m.kuwo.cn`、`www.kuwo.cn` | 支持歌单详情页 |

如果来源平台只返回部分曲目，接口会用 `limited: true` 标记。

### 功能特性

- 自动识别歌单来源平台。
- 解析歌单名、封面、创建者、曲目顺序、歌名、歌手、专辑和时长。
- 通过 Server-Sent Events 实时显示解析进度。
- 使用 Worker 侧队列保护免费额度。
- 前端展示排队位置和预计等待时间。
- 通过 MusicKit JS 在浏览器中完成 Apple Music 授权。
- 使用用户输入的名称创建 Apple Music 歌单。
- 按歌名、歌手和专辑在 Apple Music 曲库中搜索匹配。
- 保留源平台别名，规范化全角、重音和组合字符，改善外文歌曲匹配。
- 日文、韩文、俄文歌曲可通过原语言地区曲库辅助识别，再以 ISRC 查找用户所在地区的对应录音。
- 全站共享搜索缓存和限流协调，合并正在进行的相同查询。
- 批量导入匹配成功的歌曲。
- 实时展示成功数、失败数、总进度和失败详情。
- 支持导出解析后的 JSON 数据。

### 工作流程

1. 用户打开在线页面。
2. 用户粘贴支持平台的公开歌单链接。
3. 浏览器加入 Worker 侧队列。
4. Worker 解析歌单并推送进度事件。
5. 前端展示解析出的曲目列表。
6. 用户连接 Apple Music。
7. MusicKit JS 在浏览器中完成 Apple ID 授权。
8. M2M 创建 Apple Music 歌单。
9. 系统搜索、匹配并导入曲目。
10. 前端展示导入结果和失败曲目。

### 项目结构

- `src/index.js`：Cloudflare Worker 入口、路由、CORS、API 响应和 Apple token 接口。
- `src/frontend.js`：浏览器 UI、队列流程、MusicKit 集成、匹配和导入进度。
- `src/playlist.js`：多平台歌单来源识别和解析。
- `src/netease.js`：网易云歌单解析器。
- `src/apple.js`：Apple Music Developer Token 生成。
- `src/matching.js`：多语言匹配、录音识别与版本检查。
- `src/apple-catalog.js`：公开曲库缓存、共享请求调度与 Apple 限流处理。
- `src/queue.js`：Durable Object 队列协调器。
- `test/*.test.js`：Node.js 测试。

### 隐私模型

M2M 不会在服务端保存用户账号、Apple ID、Apple Music User Token 或个人资料库数据。

后端只负责：

- 解析公开歌单链接。
- 维护临时排队状态。
- 生成站点级 Apple Music Developer Token。
- 搜索 Apple Music 公开曲库，临时缓存曲库搜索结果。

用户级 Apple Music 授权由 MusicKit JS 在浏览器内完成。修改用户 Apple Music 资料库的请求使用浏览器中的 Music User Token。

曲库请求仅携带地区和公开歌曲信息，不携带 Music User Token。共享内存缓存最多保留 500 个查询，有结果缓存 6 小时，空结果缓存 5 分钟；不会写入 Durable Object 持久存储，实例重启后可能清空。创建歌单和写入资料库仍由浏览器直接请求 Apple。

### Apple Music 授权

Apple Music 需要两层 token：

- Developer Token：站点级 token，用来标识这个网站或应用。
- Music User Token：用户级 token，用户在浏览器中授权 Apple ID 后由 MusicKit JS 生成。

最终用户不需要提供 Apple 开发者账号。部署者需要配置站点级 Apple Music API 凭据。

Worker 支持的配置：

| 变量 | 是否必需 | 说明 |
| --- | --- | --- |
| `APPLE_TEAM_ID` | 自动签发时必需 | Apple Developer Team ID |
| `APPLE_KEY_ID` | 自动签发时必需 | Apple Music API Key ID |
| `APPLE_PRIVATE_KEY` | 自动签发时必需 | Apple Music API `.p8` 私钥内容 |
| `APPLE_DEVELOPER_TOKEN` | 可选替代 | 预签名 Developer Token |
| `APPLE_TOKEN_TTL_SECONDS` | 可选 | token 有效期，默认 `43200` |

自动签发和预签名 token 二选一即可。不要把 `.p8`、`.dev.vars` 或真实 token 提交到 Git。

### API

#### `GET /playlist`

解析一个支持平台的公开歌单链接。

参数：

- `url`：歌单链接。
- `limit`：可选，限制解析曲目数量，主要用于测试。

示例：

```sh
curl "https://m2m.xinyu017722.workers.dev/playlist?url=https%3A%2F%2F163cn.tv%2F8kPnBRH"
```

返回示例：

```json
{
  "sourceUrl": "https://163cn.tv/8kPnBRH",
  "resolvedUrl": "https://music.163.com/playlist?id=486271477",
  "source": {
    "key": "netease",
    "name": "网易云音乐"
  },
  "playlist": {
    "id": 486271477,
    "name": "歌单名称",
    "trackCount": 1501
  },
  "extractedCount": 1501,
  "missingCount": 0,
  "limited": false,
  "tracks": [
    {
      "index": 1,
      "id": 2744403189,
      "name": "歌曲名",
      "artists": ["歌手名"],
      "album": "专辑名",
      "durationMs": 235356
    }
  ]
}
```

#### `POST /playlist`

使用 JSON 请求体解析歌单链接。

```json
{
  "url": "https://163cn.tv/8kPnBRH",
  "limit": 50
}
```

#### `POST /playlist/stream`

以 Server-Sent Events 形式返回解析进度。浏览器使用这个接口，避免把歌单链接和队列票据放在 URL 中。

事件类型：

- `progress`：解析进度。
- `done`：最终歌单数据。
- `app-error`：标准化错误信息。

兼容接口仍然保留：

- `POST /netease/playlist`
- `POST /netease/playlist/stream`

#### `GET /apple/developer-token`

返回 MusicKit JS 使用的 Apple Music Developer Token。

#### `POST /apple/catalog`

通过共享协调器搜索公开歌曲，或按 ISRC 查找对应录音。请求体为 `{ "action": "search", "storefront": "cn", "term": "歌名 歌手", "limit": 25 }` 或 `{ "action": "isrc", "storefront": "cn", "isrcs": ["JPWP01671360"] }`，返回 `data` 与 `cacheHit`。无需提供用户授权凭据，也不会向 Apple 转发用户 token。

临时错误会包含 `error.details.retryAfterMs`，前端按完整等待时间重试。多次临时失败后暂停导入，当前曲目不会被计为未找到。

### 本地开发

```sh
npm install
npm test
npm run dev
```

Wrangler 配置使用 `keep_names = false`，保证嵌入浏览器的共享匹配器在打包后仍可独立运行；构建回归测试会使用部署配置验证这一点。

本地测试解析接口：

```sh
curl "http://localhost:8787/playlist?url=https%3A%2F%2F163cn.tv%2F8kPnBRH&limit=10"
```

如果要本地测试 Apple Music 导入，创建 `.dev.vars`：

```sh
APPLE_TEAM_ID=YOUR_TEAM_ID
APPLE_KEY_ID=YOUR_KEY_ID
APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----"
```

或者使用预签名 Developer Token：

```sh
APPLE_DEVELOPER_TOKEN=YOUR_PRE_SIGNED_DEVELOPER_TOKEN
```

生成预签名 token：

```sh
npm run --silent apple:token -- \
  --team-id YOUR_APPLE_TEAM_ID \
  --private-key ~/share/AuthKey_<KEY_ID>.p8
```

查看 token 元信息：

```sh
npm run --silent apple:token -- \
  --team-id YOUR_APPLE_TEAM_ID \
  --private-key ~/share/AuthKey_<KEY_ID>.p8 \
  --json
```

### 部署

#### GitHub Actions

仓库包含 `.github/workflows/deploy-worker.yml`。

1. 创建具有 Workers 部署权限的 Cloudflare API Token。
2. 找到 Cloudflare Account ID。
3. 在 GitHub 仓库 secrets 中添加：
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
4. 推送到 `main`，或手动运行 workflow。

在 Cloudflare Workers 中配置 Apple Music secrets：

```sh
npx wrangler secret put APPLE_TEAM_ID
npx wrangler secret put APPLE_KEY_ID
npx wrangler secret put APPLE_PRIVATE_KEY
```

也可以配置预签名 token：

```sh
npx wrangler secret put APPLE_DEVELOPER_TOKEN
```

检查部署：

```sh
curl https://m2m.xinyu017722.workers.dev/health
```

`appleConfigured` 应为 `true`。

#### Cloudflare Git 集成

也可以在 Cloudflare 控制台连接 GitHub 仓库 `cunyu-wxy/M2M`。

推荐配置：

- Build command：`npm install && npm test`
- Deploy command：`npx wrangler deploy`
- Worker entry：`src/index.js`

### Worker 限制

当前 `wrangler.toml` 默认值：

- `PLAYLIST_MAX_TRACKS=2000`
- `NETEASE_MAX_TRACKS=2000`
- `NETEASE_BATCH_SIZE=200`
- `QUEUE_MAX_ACTIVE=2`
- `APPLE_SEARCH_INTERVAL_MS=250`：全站未命中缓存的 Apple 曲库请求最小启动间隔，最多两个上游请求同时进行。

曲库协调复用现有 `M2M_QUEUE` Durable Object，无需新增绑定或迁移。未配置此绑定时，本地开发只使用单个 Worker 实例内的协调器，不能作为生产环境的全站限流方案。

只有在验证队列行为、上游限流和 Apple Music 导入重试后，才建议提高这些限制。

### 当前限制

- Apple Music 搜索可能因为翻唱、混音、同名曲目或地区版权返回错误版本。
- Apple Music API 限流会影响大歌单导入。
- 无法绕过 Apple 按开发者令牌计算的额度；首次搜索及外文兜底比缓存命中慢，不保证固定每秒匹配数量。
- 原语言地区只辅助识别，最终仍需确认录音在用户地区可用；ISRC 覆盖和源歌曲元数据质量仍会限制匹配效果。
- 上游音乐平台页面结构可能变化。
- 部分酷狗分享页只暴露预览曲目。

### 路线图

- 优化 Apple Music 匹配评分和重试行为。
- 增加更完整的导入暂停和恢复控制。
- 增加更多来源平台的解析器和兜底策略。
- 在尊重上游限制的前提下优化大歌单吞吐。

### 贡献

欢迎提交 issue 和 PR。尤其欢迎：

- 无法解析的歌单链接。
- Apple Music 匹配不准的歌曲样例。
- 来源平台页面结构变化。
- 前端交互和可访问性改进。

### 开源协议

M2M 使用 [MIT License](LICENSE) 开源。

### 社区链接

- [LINUX DO](https://linux.do/)
