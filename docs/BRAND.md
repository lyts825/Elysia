# Elysia 品牌资产

当前采用“爱莉希雅 · 晶花”同人主题，参考米哈游《崩坏3》爱莉希雅的「真我·人之律者」形象。角色依据见[官方介绍](https://honkaiimpact3.hoyoverse.com/global/en-us/news/106529)和[官方角色页](https://bh3.mihoyo.com/gl/character/detail/22104)。本项目将粉色长发、精灵耳、紫色眼睛、水晶发饰与白金细节转化为角色头像；配套徽记采用晶体与花瓣的轮廓，插画使用飞花、水晶和信笺。这些是本项目制作的主题资产。

| 文件 | 用途 |
| --- | --- |
| [portrait-source.png](../assets/brand/portrait-source.png) | imagegen 制作的透明背景角色头像原稿，保留原始分辨率 |
| [app-icon.svg](../assets/brand/app-icon.svg) | 晶花徽记原稿；小尺寸 Windows 图标与 SVG favicon |
| [app-icon.ico](../assets/brand/app-icon.ico) | Windows 窗口、任务栏、桌面快捷方式；16、20、24、32、40 px 使用徽记，48、64、128、256 px 使用角色头像 |
| [app-icon.png](../assets/brand/app-icon.png) | 512 px 透明角色头像；侧栏、启动画面及其他平台窗口 |
| [mark.svg](../assets/brand/mark.svg) | 24 单位单色标记；界面通过 CSS mask 跟随文字颜色 |
| [workspace-empty.svg](../assets/brand/workspace-empty.svg) | 飞花与粉晶工作窗口；首页及预览空状态 |
| [delivery-empty.svg](../assets/brand/delivery-empty.svg) | 带水晶封印的信笺；产物列表空状态 |
| [preview.html](../assets/brand/preview.html) | 本地品牌资产总览，可检查浅色、深色与小尺寸效果 |

主色：玫瑰 `#9E4F7E`、梅紫 `#70416F`、粉晶 `#EFB6D3`、浅紫 `#D8BCE5`、珍珠白 `#FCF6FA`。界面正文保持深色，浅粉只用于装饰和背景。保留原始宽高比与透明边缘，不给图标再次叠加底色或圆角。单色标记通过背景颜色实现着色；装饰图像隐藏于辅助技术，旁边的文字承担语义。预览区在低窗口中缩小插画，优先显示状态说明。

修改 `portrait-source.png` 或 `app-icon.svg` 后，执行 `pnpm assets:build`，从两份原稿重新导出 PNG、ICO 和单色标记。头像用于 48 px 及以上的 ICO 帧；更小的帧从 SVG 渲染，避免缩小头像后细节混杂。单色标记取自 SVG 的 `emblem` 路径。导出使用项目已有的 Electron/Chromium，在隐藏窗口中离线完成，无需额外依赖或模型调用。PNG、ICO 与 SVG 都是正式产品资源，纳入 Git。

执行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/create-shortcut.ps1` 可创建或更新本项目的桌面快捷方式；其图标路径指向项目内 ICO。启动应用后，窗口和任务栏使用同一图标，任务栏重启入口仍指向 `Start-Elysia.vbs`。移动项目目录后需重新创建快捷方式。

## 头像生成记录

2026-10-07 使用内置 `image_gen` 工具生成一张头像，`transparent_background: true`。生成结果保存在 `assets/brand/portrait-source.png`，没有把官方图片文件作为项目资源。以下为最终生成提示词；矢量徽记和插画直接维护源文件。

```text
Create a finished premium DESKTOP APPLICATION ICON for an app named Elysia, inspired directly by and recognizably depicting Elysia (爱莉希雅), Herrscher of Human: Ego from miHoYo Honkai Impact 3rd. One single icon, no text, no letters, no watermark, no branding logos, no mockup or grid. Square canvas with truly transparent outer corners. A rounded-square tile occupies 94% of the canvas, centered, with elegantly rounded corners. Tile background is a rich rose quartz to plum gradient, lighter top left, darker lower right, giving excellent silhouette contrast. Inside it: a tightly composed front-facing head-and-upper-shoulders portrait of the adult female elf Elysia, enchanting calm confident smile, clear luminous violet eyes with tiny diamond-shaped highlights, fair skin, flowing pale rose-pink hair, her recognizable sweeping side fringe with long asymmetric locks, visible delicate pointed elven ears, and an elegant white and pale gold crystalline hair ornament inspired by her Herrscher of Human form. White and lilac neckline only; head/face is the main subject filling most of the tile. Portrait should be sophisticated stylized anime icon artwork with a few large clean color planes, exquisite but restrained cel-shaded rendering, soft pink-lavender glints in the hair, readable facial features at 64 pixels, graceful adult appearance rather than a baby chibi. Add at most two subtle floating crystal petal highlights, integrated within the tile, and a fine pearl rim. No busy background, no large weapon, no extended body, no small ornamental text, no grain, no photographic realism, no excessive sparkle. The icon must look like a carefully art-directed desktop app asset, warmly inviting and recognizable as Elysia, with clean alpha outside the tile.
```
