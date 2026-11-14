# NapCat Desktop

给 NapCat 的 WebUI 套一个正经的桌面外壳，省掉「先开 bat、再开浏览器、再粘 token」的流程。

## 做了什么

- **自动拉起 NapCat**：启动时检查 WebUI 端口，没起来就自己注入拉 QQ（弹一次 UAC 授权），带启动动画和进度提示
- **免 token 登录**：桌面端接管 WebUI 凭证（`NAPCAT_WEBUI_SECRET_KEY`），每次直接进面板；发现旧实例用别的 token 时会提示一键重启接管
- **原生窗口**：用 NapCat 官方 logo 生成的多尺寸图标（exe / 窗口 / 托盘 / 快捷方式统一）
- **托盘常驻**：双击托盘图标唤起面板，右键可重载、重启 NapCat、退出
- **菜单**：重新加载（F5）/ 在浏览器打开 / 复制 WebUI 链接 / 打开配置与日志目录 / 启动或重启 NapCat / 更换 NapCat 目录
- **窗口状态记忆**：位置和大小下次启动自动恢复
- 关闭窗口 = 退出外壳，NapCat 与 QQ 独立运行不受影响

## 开发

```bash
npm install          # 首次
npm start            # 开发运行
npm run check        # 无界面自检（读取配置、探测端口，输出 JSON）
npm run icon         # 由 build/logo.png 生成多尺寸 build/icon.ico
npm run pack         # 打包到 dist/NapCat-win32-x64/
```

## 目录

```
src/main.js        主进程：启动 NapCat、窗口、菜单、托盘
src/splash.html    启动动画
src/preload.js     启动页的状态通道
build/logo.png     官方 logo
build/icon.ico     多尺寸图标（16~256）
tools/make-icon.js png → ico
```

## 产物

`dist/NapCat-win32-x64/NapCat.exe`，可整个目录拷走直接运行（Electron 便携包）。

默认 NapCat 目录为 `C:\Users\Yua\apps\napcat\shell`，换位置用菜单「设置 NapCat 目录…」。
