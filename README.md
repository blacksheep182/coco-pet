# 小络 CoCo

下载 Windows x64 便携包 `CoCo-Pet-<版本>-win-x64.zip`，完整解压后双击 `CoCo.exe`。小络自带运行环境，可以在没有安装 CoWork 的电脑上使用。点击小络可以互动，拖动可以移动或抛起她，右键可以选动作或退出。隐藏后，点击系统托盘的小络图标或再次启动程序即可找回。

## 与 CoWork 联动

小络会在本机寻找普通版 NetLIVE CoWork。确认服务就绪后，小络通过已有的只读接口获取会话和待应答请求。有新提问或审批时先做互动表情，正在执行任务时显示工作动画。托盘菜单显示连接状态，连接后可以打开本机 CoWork 网页。关闭 CoWork 后小络恢复待机，CoWork 再次就绪后自动重连。

默认地址是 `127.0.0.1:17926`。使用自定义端口时，在启动小络的环境中设置 `COCO_COWORK_PORT` 或 `NLC_BACKEND_PORT`。服务的 `/health` 应返回 `app_id=com.netlive-cowork.desktop`、`status=ok`、`runtime=true`。连接后每三秒读取 `GET /api/v1/sessions` 和 `GET /api/v1/hitl/pending`，断开后每十秒重试。联动范围为本机后端返回的会话。

## 开发与发布

在 Windows x64 安装 Node.js 24 后，进入本项目运行：

```powershell
npm ci
npm start
npm test
npm run build
```

产物在 `dist/`。小络的源码、动画、依赖锁和构建配置都在本仓库。更新小络时，退出旧版，解压新版并运行。位置保存在独立的 Electron 用户数据目录，跨小络版本复用。

要在独立的 GitHub 仓库提供下载，启用 Actions，更新包版本与依赖锁，推送对应标签（例如 `v0.1.0`）。发布工作流会测试、构建并把 ZIP 附到该仓库的 Release。CoWork 可按自己的版本节奏更新；公开接口如有不兼容变化，仅需调整本项目的 `lib/cowork-activity.js`。
