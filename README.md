# GidHub

用 GitHub 账号真的建一个网站。

连接 GitHub key 后，在站内填标题和介绍、选模板，GidHub 会：

1. 在你的账号下创建仓库
2. 提交 `index.html` 和 `README.md`
3. 开启 GitHub Pages
4. 返回一个可以直接打开的网址

站点同时是一个 GitHub 客户端：仓库、文件、Releases、Issues 都实时读 GitHub API；改文件、开 Issue 也会真的写回 GitHub。

## 说明

- key 只保存在浏览器 localStorage，请求直接发往 `api.github.com`，不会进入页面源码或仓库。
- 免费账号的 GitHub Pages 只支持公开仓库。
- 这是个人项目，不是 GitHub 官方页面。

## 地址

https://acmagnus.github.io/gidhub/
