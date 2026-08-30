# Search Agent

[![test](https://github.com/kun111-web/search-agent/actions/workflows/test.yml/badge.svg)](https://github.com/kun111-web/search-agent/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

内置浏览器 + 页面信息采集。开着几个要盯的网站，它把新出的条目抓下来，交给大模型判断哪些值得看，留下的按天入库。窗口可以缩成一个悬浮球贴在屏幕边上，新消息在球边上冒出来。

- **采集**：在页面里注入探针盯着 DOM 变化，同时最多盯两个标签页，各自算配额、各自失败重试，一个站挂了不影响另一个。
- **筛选**：成批送模型判定，判定结果按模型分区缓存，同一条内容不重复花 token。主模型断了自动切备用。
- **入库**：留下的按天存成 JSONL，同一条内容只存一份，可导出 Markdown / CSV / JSON。
- **悬浮球**：可拖、可缩放、记住上次大小；两行状态栏分别显示采集和模型的状态。

## 跑起来

需要 Node.js 18 以上。

```bash
npm install
npm start
```

打包成 Windows 安装包：

```bash
npm run dist
```

## 先把模型配好

源码里**不带任何接口地址、模型名和 API Key**，得自己填。开程序后点右侧「采集」面板 → 「设置」，填这三样：

| 项 | 说明 |
| --- | --- |
| API Base URL | 填到 `/v1` 即可，例如 `https://api.example.com/v1`。也可以把完整路径填进去，程序不会重复拼接。 |
| 模型 | 模型名，照你那家的文档写。 |
| API Key | 存盘时用 Windows DPAPI 加密，绑定当前系统账户。 |

三样填齐才算配好一个模型，缺一样这个模型就不参与筛选。

### 两种接口格式

不同厂家的接口长得不一样，设置里的「接口格式」按你那家的选：

| | `chat` | `responses` |
| --- | --- | --- |
| 路径 | `{地址}/chat/completions` | `{地址}/responses` |
| 提示词 | 全放在 `messages` 里 | 系统提示进 `instructions`，其余进 `input` |
| 取回复 | `choices[0].message.content` | 遍历 `output` 数组找 `output_text` |

拿不准就先选 `chat`——绝大多数厂家都兼容这套。选错了会得到一个 4xx，设置面板的「测试连接」能当场看出来。

两处细节值得一提：`responses` 那套的正文不保证在 `output[0]`，数组里常垫着 reasoning 和工具调用项，所以是遍历着找的；这套格式默认会把每轮对话存在服务端，程序显式关掉了（`store: false`），采到的内容不留在别人机器上。

### 备用模型

再配一组就是备用。主模型遇到网络问题、限流、Key 不对、模型名不对时自动切过去，切换是"粘"的——不会每批都去撞一次超时，等 5 分钟冷却后才回头试主模型。主备的接口格式各选各的，两家不是同一套也没关系。

模型答的不是可用 JSON 时不切换：换一家大概率一样，白花一遍 token。

## 默认盯哪些站

`electron/default-sites.js` 里是空的。想让程序一开就把常看的几个站摆好，填进去：

```js
const DEFAULT_SITES = [
  { url: "https://example.com/", label: "站点名" },
];
```

填了之后，开程序会自动打开这些页面并在采集面板里勾上，直接点「开始采集」就行。留空则给一个空标签页，手动打开的站照样能勾选采集。

## 数据存在哪

都在 Electron 的 userData 目录下（Windows 是 `%APPDATA%\Search Agent\`）：

| 文件 | 内容 |
| --- | --- |
| `agent-settings.json` | 设置，Key 是密文 |
| `pool/*.jsonl` | 采集池，还没筛的原始条目 |
| `archive/*.jsonl` | 按天入库的结果 |
| `filter-cache.json` | 模型判定缓存 |
| `session.json` | 上次开着哪些标签页 |

源码目录里不会留任何运行时数据。

## 测试

```bash
npm test
```

七个套件共 141 项。其中六个跑在 Electron 运行时里（要用到 `app`、`safeStorage` 这些），一个是纯 Node 的：

| 套件 | 盯的是 |
| --- | --- |
| `api-format-test.js` | 两种接口格式的请求体、路径、响应解析、主备各用各的格式（起本地 HTTP 服务当模型） |
| `bugfix-test.js` | 缓存分区、错误归类、停止后重开、探针撤除、按站配额、设置文件损坏、悬浮球几何 |
| `dedup-fix-test.js` | 去重指纹、归档格式迁移 |
| `orb-render-test.js` | 悬浮球的滚动位置、新消息高亮、鼠标穿透 |
| `picks-render-test.js` | 采集面板的勾选列表重建 |
| `retry-pace-test.js` | 断连退避的节奏、重连状态 |
| `scrape-flow-test.js` | 采集到入库的整条链路 |

Windows 上想看到 Electron 那几个套件的输出，得先开日志：

```powershell
$env:ELECTRON_ENABLE_LOGGING="1"
npx electron bugfix-test.js
```

## 代码怎么摆的

```
electron/            主进程
  main.js            入口：窗口、IPC、启动收尾
  tabs.js            标签页和探针注入
  live-probe.js      注入到页面里的探针脚本
  orb.js             悬浮球窗口
  default-sites.js   默认盯哪些站（默认空）
  agent/
    scraper.js       采集编排：轮询、配额、重试、退避
    llm.js           模型 HTTP 调用，两种接口格式在这儿
    model-pool.js    主备切换
    filter.js        筛选与判定缓存
    archive.js       按天入库
    settings.js      设置读写与 Key 加密
    dedup.js         去重指纹
src/                 渲染层：浏览器外壳、采集面板、悬浮球界面
bundle/              把安装包和本机配置打成一个分发文件夹的脚本
```

`bundle/` 里那个脚本会把**本机的明文 Key** 嵌进导入脚本，方便装到自己的另一台机器上。生成出来的文件夹别整个发给不该看到 Key 的人。

## 许可

MIT
