# Elysia 品牌资产

当前方向为“日常花结”：提炼爱莉希雅常服与《黄金庭院》的日常氛围，用于本机协作工作台。用户明确要求参考相关元素，因此图标、启动页及代理标记均采用抽象矢量图形。当前资源不使用角色头像、律者冠饰或水晶徽记。

参考作品为《黄金庭院：冬日里的新年愿望》，可查看[米哈游出品页面](https://www.bilibili.com/bangumi/media/md28351532/)和[官方第 1 集](https://www.youtube.com/watch?v=3EI0abhg5cs)。以下是本项目的设计转译，不是对服装结构或动画道具的逐项复刻。

| 参考元素 | 在应用中的转译 |
| --- | --- |
| 粉色发丝与轻盈曲线 | 柔粉主色、弧形花结与飘带轮廓 |
| 常服的白色领口与织物感 | 奶油白主体、柔和折边；降低珠光与金属质感 |
| 常服的深色搭配、小配饰 | 墨灰侧栏与小面积香槟金圆扣 |
| 庭院中的轻松相处与生活氛围 | 窗边笔记、热茶和系结信笺，作为工作与交付的隐喻 |

| 文件 | 用途 |
| --- | --- |
| [app-icon.svg](../assets/brand/app-icon.svg) | 统一花结图标原稿；侧栏、启动页与 SVG favicon |
| [app-icon.ico](../assets/brand/app-icon.ico) | Windows 窗口、任务栏、桌面快捷方式；16、20、24、32、40、48、64、128、256 px 均使用同一标识 |
| [app-icon.png](../assets/brand/app-icon.png) | 512 px 透明边缘导出；其他平台窗口和通用资源 |
| [mark.svg](../assets/brand/mark.svg) | 24 单位单色花结；CSS mask 跟随文字颜色 |
| [workspace-empty.svg](../assets/brand/workspace-empty.svg) | 窗边小记：笔记本、书签与热茶；首页及预览空状态 |
| [delivery-empty.svg](../assets/brand/delivery-empty.svg) | 系结信笺：纸张、花结与暖金圆扣；产物列表空状态 |
| [preview.html](../assets/brand/preview.html) | 本地品牌总览；浅色、深色与不同尺寸效果 |

配色为干玫瑰 `#92536F`、柔粉 `#D9ACBE`、灰紫 `#A99AAF`、香槟金 `#D8B894`、奶油白 `#FCF8F3`。正文和操作使用较深的颜色，浅色用于背景和装饰，状态色保留明确语义。

保留图标原始宽高比和透明边缘，避免重复叠加底色或圆角。装饰图像对辅助技术隐藏，旁边的文字承担语义；低窗口中缩小空状态插画，优先显示说明。

修改 `app-icon.svg` 后执行 `pnpm assets:build`，使用已有 Electron/Chromium 离线导出 PNG、九尺寸 ICO 和单色标记。单色标记读取 SVG 的 `emblem` 路径，各尺寸应用图标均由同一原稿生成。此版本直接维护矢量源文件，无需图像生成或新依赖。

执行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/create-shortcut.ps1` 可更新桌面快捷方式。图标路径指向项目内 ICO；移动项目目录后需要重新创建快捷方式。

`v0.4.3-preview.1` 的角色头像与生成记录已从当前资源中移除，可通过该 Git 标签恢复。历史版本的图像原稿不再参与构建。

## 动效约定

动作保持轻快、安静，与“日常花结”的视觉风格一致。交互发生时立即响应，位移幅度小，使用无回弹的缓出曲线。静止的工作台不播放持续装饰动画。

| 场景 | 表现与时长 |
| --- | --- |
| 按钮与卡片 | 主要按钮按下 90 ms 缩至 97%；卡片悬停上移 2 px、按下缩至 99%，色彩反馈 140 ms |
| 侧栏与标签 | 240 ms，从当前屏幕位置接续；布局仅在切换时测量，动画使用 transform |
| 弹窗 | 240 ms 淡入并上移 12 px；160 ms 沿原方向退出，遮罩同步淡出 |
| 代理预览 | 从右侧 20 px 淡入，向右侧淡出；中途重新展开保留当前代理、视图与页面 |
| 页面与内容 | 5–6 px 轻移和淡入；首页分组最多错开 65 ms，插画只在出现时播放一次 |
| 运行状态 | 仅正在生成的状态点轻微呼吸；预算进度用 scaleX 更新，不重排内容 |

可复用实现为 `apps/web/src/Motion.tsx`，时长和曲线统一维护在 `motion.css`。使用原生 [Web Animations API](https://developer.mozilla.org/en-US/docs/Web/API/Element/animate)，不增加依赖。退出时立即解除模态隔离、恢复焦点，退场元素设为 inert；未保存更改的确认逻辑优先于退场。

系统开启 `prefers-reduced-motion: reduce` 时，停止 CSS 和 JavaScript 位移动效、按压缩放与循环动画；正在播放的动画也立即结束，关闭无需等待动画事件。保留静态颜色、焦点边框和文字反馈。实时消息、预览轮询及模型信息刷新不触发内容重新入场，展开预览不重新挂载 iframe。
