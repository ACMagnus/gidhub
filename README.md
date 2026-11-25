# GidHub

用 GitHub 账号真的建一个网站。

填标题和介绍、选模板，GidHub 会在你的账号下：

1. 创建仓库
2. 提交 `index.html` 和 `README.md`
3. 开启 GitHub Pages
4. 返回一个可以直接打开的网址

站点同时是一个 GitHub 客户端：仓库、文件、Releases、Issues 都实时读 GitHub API；改文件、开 Issue 也会真的写回 GitHub。

## 两种运行方式

### 公开静态版

直接打开 `index.html`，或访问 GitHub Pages。第一次连接时粘贴自己的 GitHub token，token 只存在当前浏览器的 `localStorage`，请求直连 `api.github.com`。

- 适合公开演示，或让每个访客用自己的账号。
- 公开页面不能内置站主的 token：前端代码谁都能看，任何加密或混淆都能还原。
- 公开仓库不能放私有 key。

### 私有后端版（站主自用）

`server.js` 是一个单文件 Node 服务，提供：

- 站主密码登录，会话 Cookie，30 天
- GitHub token 只存在服务端（默认读取 `~/.config/gh/hosts.yml`，也可用 `GITHUB_TOKEN`）
- `/api/github/*` 代理 GitHub API
- `/api/asset?url=` 代理私有仓库的 raw / release 文件
- 浏览器只拿到登录会话，页面源码、仓库、网络请求里都没有 token

启动：

```bash
node server.js
```

默认监听 `127.0.0.1:8787`。首次启动会在 `~/.config/gidhub/` 生成站主密码和配置：

- `~/.config/gidhub/login.txt`：站主密码，权限 600
- `~/.config/gidhub/auth.json`：密码哈希，权限 600

多设备访问同一个后端时，每台设备只需输入一次站主密码。token 不会下发到任何设备。

## 说明

- 免费账号的 GitHub Pages 只支持公开仓库。
- 私有后端版需要一台能运行 Node 的机器；公开静态版不需要。
- 这是个人项目，不是 GitHub 官方页面。

## 地址

- 公开静态版：https://acmagnus.github.io/gidhub/
- 示例站：https://acmagnus.github.io/gidhub-demo/
