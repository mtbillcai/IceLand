# Iceland · 私人行李清单

保留离线清单的分类、搜索、增删改、勾选和撤销功能，并通过 GitHub 私有仓库同步。

## 部署结构

- `IceLand`：网页代码。GitHub Pages 发布 `main` 分支的 `/docs` 目录。只包含通用界面，不包含个人物品数据或凭证。
- `IceLand-data`：私有数据仓库，`main` 分支的 `checklist.json` 保存清单。请保持 Private，且不要添加其他协作者。
- `docs/config.json`：默认数据仓库位置，不存放令牌。
- 原 HTML 与 `private-data/`：只在本机保留，已排除提交。

公开网页入口仅显示连接界面。GitHub API 验证令牌可以访问私有清单后，才显示物品。所有写入都由 GitHub 仓库权限控制；网页内没有公开的写入凭证。

## 换一台电脑使用

1. 打开部署后的网站，点击「GitHub 同步设置」。
2. 仓库位置已填好，在 GitHub 的令牌设置页点击「Generate token」，将生成的细粒度令牌粘贴到网站中，再点击「解锁并加载清单」。仅登录 GitHub 账号还不能解锁清单。
3. 修改后等待「已与 GitHub 同步」，另一台电脑点击「立即同步」或重新打开页面。

令牌只选 `IceLand-data` 仓库，Repository permissions 的 Contents 设为 Read and write。设置合适的到期时间，不要把令牌写入代码、清单、聊天或公开仓库。令牌仅保存在当前标签页的 sessionStorage 中；浏览器恢复会话时可能恢复该令牌。使用完共享电脑请点击「退出连接并清除本机缓存」，并关闭相关标签页。

清单副本会保存在当前浏览器 localStorage 中以保护未同步修改；这不是设备级加密保险箱。任何能进入该浏览器配置的本机使用者，都可能访问缓存。因此私人电脑使用独立系统账户，共享电脑用完请退出清单连接。云端权限始终由 GitHub 私有仓库控制。

## 数据保护与限制

- HTML/JSON 导入保留物品 ID、分类、备注、数量、携带计划与勾选状态。下载 JSON 备份不含令牌。
- 每次同步先拉取最新版本，再对比共同基线。不同物品或不同字段的修改可合并；同一字段及删除/编辑冲突需要逐项确认。
- 提交带文件 SHA。如果另一个设备刚写入，GitHub 拒绝旧版本覆盖，当前修改留在本机，重新同步即可。
- 同一浏览器同一清单只有一个标签页可编辑，避免多个页面覆盖本地暂存。
- 已解锁、已打开的页面可以断网编辑，联网后重试。完整离线冷启动暂不支持；首次解锁需要访问 GitHub。
- 刷新或关闭前以同步状态为准。自动保存不是多人实时协作文档。
- 未导入令牌时不会匿名读取私有清单。

## 本地预览

需要 Node.js 20 或更新版本。

```powershell
npm start
```

打开 `http://127.0.0.1:4173/`。若本机存在 `private-data/checklist.json`，预览会加载它，默认不连接 GitHub，也不会改动云端。预览服务器只监听本机地址，不要将开发服务器公开到网络。

```powershell
npm test
```

同步合并与 GitHub API 行为使用模拟服务验证。真实网站发布后仍需验证登录、读取与一次保存。

参考：[GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)、[GitHub 文件内容 API](https://docs.github.com/en/rest/repos/contents)、[创建访问令牌](https://github.com/settings/personal-access-tokens/new)。
