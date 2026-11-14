# 编译产物 / Build Artifacts

本目录存放从 `packages/` 源码构建出的可运行发行包，用于上游仓库下架后的本地归档。

## 现有产物

| 文件 | 版本 | 平台 | 大小 | 来源 |
|---|---|---|---|---|
| `NapCat.Shell-4.18.42-win-x64.zip` | 4.18.42（对应源码 tag `v4.18.42`） | Windows x64 | 约 33 MB | 2026-10-30 本地构建 |

SHA256：

```
56fd41f430ebb25ad21896a2f165219134ccdfe241603ac5dcf92ed1175fd183  NapCat.Shell-4.18.42-win-x64.zip
```

## 压缩包内容

- `napcat.mjs`：打包后的主程序
- `native/`：QQ NT 相关原生模块（约 100 MB 解压后）
- `static/`、`worker/`：WebUI 静态资源与 worker
- `node_modules/`：运行时依赖（express / ws 等）
- `launcher.bat`、`launcher-elevate.ps1`、`NapCatWinBootMain.exe`、`NapCatWinBootHook.dll`、`loadNapCat.js`、`qqnt.json`、`icon.ico`、`conout-*.js` 等启动文件

## 已排除的运行时/隐私文件

打包时已剔除以下内容，避免把个人数据带进仓库：

- `config/`：账号配置、OneBot 连接配置（含 token）
- `logs/`、`cache/`、`launcher.log`
- `*.db`、`*.db-shm`、`*.db-wal`：本地数据库
- `plugins/`：本机安装的插件及其数据

## 使用方式

解压后把 `NapCatWinBootMain.exe` 放到 QQ 安装目录（或按 `launcher.bat` 的方式启动），首次启动会重新生成 `config/`。

## 后续维护

源码改动后重新构建（`pnpm build:shell`），把新的发行包按 `NapCat.Shell-<版本>-win-x64.zip` 命名放入本目录，并更新本文件的表格与 SHA256。
