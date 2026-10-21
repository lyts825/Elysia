# Elysia 界面规范

v1.19.0 · 2026-10-21。原生 API 与 Agent 终端使用同一套视觉语言：低饱和玫瑰色、清晰的文字层次、稳定的操作位置。功能模块通过共享样式变量接入规范，保留独立页面和业务边界。

## 唯一基础来源

`apps/web/src/design-tokens.css` 定义基础颜色、字体、尺寸、圆角、阴影和动效。`style.css` 提供通用控件；功能CSS只负责模块布局和必要变体。避免在文件末尾叠加重复覆盖，直接调整所属规则。

| 类别 | 规范 |
| --- | --- |
| 字号 | 辅助12、说明13、正文/控件14、区块16、标题20/24、页面主标题32px；使用对应font变量 |
| 缩放 | 根字号100%，文字与主要间距使用rem，跟随浏览器字号和缩放 |
| 行高 | 标题1.3、紧凑控件1.45、正文1.65；代码与长文可有明确的阅读行高 |
| 字重 | 正文400，标签500/600，标题600/650；大标题使用轻微负字距 |
| 间距 | 4、8、12、16、20、24、32、40px，使用space变量；图形定位不机械取整 |
| 圆角 | 小标记6、控件10、卡片14、浮层20px，胶囊使用pill；圆点/仪表保留几何比例 |
| 控件 | 紧凑32、标准38、触摸44px；输入和选择框与标准按钮对齐，图标居中 |
| 阴影 | 小控件使用shadow-sm，菜单使用shadow-popover，弹窗使用shadow-panel |

## 控件与状态

- 主按钮用accent底与on-accent文字；次按钮使用surface底、明确边框；轻量操作用quiet/text按钮。危险操作使用danger，不能仅靠图标区别。
- 文本框、选择框和文本域统一边框、圆角与焦点；复选框/单选框保留原生语义。标签就近，说明使用辅助字号，错误使用danger。业务动作显式使用通用按钮类，选项卡、分页等专用控件由模块样式声明。
- 悬停、按下、选中、禁用分别处理。选中状态不被悬停覆盖；禁用元素不显示可执行按压反馈；键盘焦点保持可见。
- running/ready使用accent；waiting/verification使用warning；完成使用success；失败使用danger。状态文字与图标保留，不能仅依赖颜色。
- 弹窗共享标题、关闭位置、内容滚动与底部操作区。窄屏操作允许换行，内容滚动不隐藏最后一个按钮。菜单、选项卡和导航使用一致的选中背景。
- 会话、计划、工具、请求和任务卡片采用相同边框和间距。代码与Markdown保持内容自身的层次；长代码/表格在局部滚动，不撑宽页面。

## 页面覆盖

| 范围 | 样式文件（apps/web/src） |
| --- | --- |
| 基础、主页、入口与启动 | style、motion、home、surface、Startup |
| 预览与文档 | preview、preview-dock、markdown、file-content、file-page |
| 模型、上下文和会话 | providers、context-window、composer-model-control、conversation-search、sessions、reasoning |
| 执行与终端 | local-agents、terminal-control、terminal-communication、tool-activity、task-working-state、features/plan-alignment/plan-alignment |
| 项目 | project-workbench、project-files、project-usage、project-intelligence、project-schedules、project-schedule-history |
| 交付与工作流 | project-delivery-bundle、project-draft-backup、project-plan-transfer、workflow、readiness、task-center、delivery-read-progress、workbench-persistence |

以上36份CSS统一引用共享规范。供应商标识保留独立brand变量；用户自定义启动颜色、进度宽度、任务深度、图形坐标和代码行定位属于内容或几何数据，允许动态计算。Startup.css独立导入tokens，便携包同时包含两份资源。桌面与Web默认启动色在各自配置中同步，已有偏好不迁移覆盖。

## 可访问性与维护

核心文字与对应背景对比至少4.5:1。辅助说明不以降低透明度替代可读的颜色；用户自定义启动背景按亮度选择文字色。减少动效使用静态状态，增强对比度提高边框和文字区分。供应商标志色只表示身份，不替代状态文字。

新增界面必须复用上述变量与控件。验收检查桌面、窄屏、放大文字或2倍缩放、长中文、键盘、禁用和错误状态；关注被overflow隐藏的内容，不能只以页面没有滚动条判定合格。实际验证结果与未覆盖范围记录在EXECUTION.md；测试材料保留本地忽略目录。
