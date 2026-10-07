# Elysia 品牌资产

“星瓣”由四片花瓣围成中心星光，延续工作台的紫色识别。应用图标使用紫晶底色与浅色花瓣；单色标记用于总代理、模型连接和紧凑控件。插画只放在没有内容的区域，保留状态说明和操作入口。

| 文件 | 用途 |
| --- | --- |
| [app-icon.svg](../assets/brand/app-icon.svg) | 应用图标原稿；侧栏、启动画面与 SVG favicon |
| [app-icon.ico](../assets/brand/app-icon.ico) | Windows 窗口、任务栏、桌面快捷方式；含 16、20、24、32、40、48、64、128、256 px |
| [app-icon.png](../assets/brand/app-icon.png) | 512 px 透明背景导出；其他平台的窗口图标与通用资源 |
| [mark.svg](../assets/brand/mark.svg) | 24 单位单色标记；界面通过 CSS mask 跟随文字颜色 |
| [workspace-empty.svg](../assets/brand/workspace-empty.svg) | 首页及预览的空状态插画 |
| [delivery-empty.svg](../assets/brand/delivery-empty.svg) | 产物列表的空状态插画 |
| [preview.html](../assets/brand/preview.html) | 本地品牌资产总览，可检查浅色、深色与小尺寸效果 |

主色：紫晶 `#7056B5`、深紫 `#563581`、浅紫 `#B09AE1`、花瓣 `#E1D2FA`、背景 `#F7F5FA`。保留原始宽高比与透明边缘，不给图标再次叠加底色或圆角。单色标记通过背景颜色实现着色；装饰图像隐藏于辅助技术，旁边的文字承担语义。

修改 `app-icon.svg` 后，执行 `pnpm assets:build`，从原稿重新导出 PNG、ICO 和单色标记。导出使用项目已有的 Electron/Chromium，在隐藏窗口中离线完成，无需额外依赖。`petal` 路径是各尺寸标记的共同几何源。PNG、ICO 与 SVG 都是正式产品资源，纳入 Git。

执行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/create-shortcut.ps1` 可创建或更新本项目的桌面快捷方式；其图标路径指向项目内 ICO。启动应用后，窗口和任务栏使用同一图标，任务栏重启入口仍指向 `Start-Elysia.vbs`。移动项目目录后需重新创建快捷方式。
