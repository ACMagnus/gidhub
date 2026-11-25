# GidHub

用 GitHub 账号真的建一个网站。

填标题和介绍、选模板，GidHub 会在你的账号下：

1. 创建仓库
2. 提交 `index.html` 和 `README.md`
3. 开启 GitHub Pages
4. 返回一个可以直接打开的网址

站点同时是一个 GitHub 客户端：仓库、文件、Releases、Issues 都实时读 GitHub API；改文件、开 Issue 也会真的写回 GitHub。

## 公开静态版

直接打开 `index.html`，或访问 GitHub Pages。第一次连接时粘贴自己的 GitHub token，token 只存在当前浏览器的 `localStorage`，请求直连 `api.github.com`。

- 适合公开演示，或让每个访客用自己的账号。
- 公开页面不能内置站主的 token：前端代码谁都能看，任何加密或混淆都能还原。
- 公开仓库不能放私有 key。

## 私有后端版

私有控制台的源码、部署方式和登录机制不在这个公开仓库里。公开仓库只保留静态站前端。

私有版的能力：

- 站主密码登录，会话 Cookie
- GitHub token 只在服务端，AES-256-GCM 加密保存
- 浏览器、页面源码、公开仓库和网络请求里都没有 token
- 多设备登录同一个后端，key 只在服务端

## 说明

- 免费账号的 GitHub Pages 只支持公开仓库。
- 这是个人项目，不是 GitHub 官方页面。

## 地址

- 公开静态版：https://acmagnus.github.io/gidhub/
- 示例站：https://acmagnus.github.io/gidhub-demo/

## 免 key 建站

公开站可以不用 key 预览和下载 HTML。需要真正发布到 GitHub Pages 时：

- 访客在公开站填好内容，点“提交审核（不用 key）”，会打开一个 GitHub Issue 申请；
- 站主在私有控制台“审核”页确认 HTML，再用服务端保管的 key 发布；
- 访客全程不需要输入 key，站主的 key 也不会进入公开页面或公开仓库。
