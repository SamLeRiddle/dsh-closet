# 匣（dsh-closet）

[English](README.md) | **简体中文**

把 DeepSeek Harness 侧栏里零碎的第三方插件入口，收进可折叠的小盒子。

**当前发布：0.1.4。** [下载与更新说明](https://github.com/SamLeRiddle/dsh-closet/releases/tag/v0.1.4)。运行代码沿用 Windows 已复测的 0.1.3 build r2。

![多个匣按需展开或收起，入口仍打开原插件面板](docs/images/sidebar-overview.png)

![在设置中创建匣、改名排序，并用下拉框分配入口](docs/images/settings-assignment.png)

图中以「常用」「开发」「工具」三个匣为例，展示侧栏收纳和入口归属的设置方式。

## 它做什么

- 创建多个匣，各自独立展开、收起；匣头显示当前可用入口数量。
- 点击匣内入口打开原插件面板，当前入口高亮，收起后保留活动标记。
- 收纳后的原始入口不再重复占位，插件本身继续工作。
- 第三方插件停用后，代理入口和数量跟随实际侧栏变化；重新启用时恢复原归属。
- 官方入口不参与收纳。0.1.4 修复了英文界面下官方入口误识别。

## 怎么配置

装好后打开 **设置 → 匣**：

- 新建、改名、排序、删除匣；删除时成员回到匣外。
- 通过每个入口右侧的下拉框选择归属，也可放回匣外。
- 新入口默认在匣外，按需分配。

改动立即反映在界面上，并串行保存到本机 `<DSH_HOME>/config/dsh-closet.json`（默认 `~/.dsh/config/dsh-closet.json`）。保存期间合并等待中的编辑；保存失败保留当前编辑并提供重试。刷新后重新读取落盘配置。

只有配置文件不存在时才创建默认配置。权限、占用等读取失败会报错并支持重试，不移动或重写原文件。无效 JSON 先成功备份再重建，已有 `.broken` 保留，后续使用 `.broken.1` 等名称。备份失败时保留原文件并报错。

## 安装与升级

在 [Release](https://github.com/SamLeRiddle/dsh-closet/releases/tag/v0.1.4) 下载 ZIP 或 TGZ：ZIP 解压后安装其中的 `dsh-closet` 目录；TGZ 交给对应 DSH 环境的插件管理器安装。

Windows Desktop 使用其自带的 CLI 或实际版本提供的插件管理器，并选择 desktop profile。安装后按宿主要求完整重启 DSH。安装器的实际位置以本机为准。

升级前备份配置。配置格式仍为版本 1，无需迁移已有有效配置。如果旧版曾误收官方入口，先在设置里放回匣外；本版不自动清理已有记录。

## 接口前缀

默认前缀为 `/closet`。可在 profile 的 `cordis.patch.yml` 覆盖配置：

```yaml
- id: closet
  config:
    routePrefix: /custom
```

重启 DSH 后刷新页面，Host 与界面会使用同一配置接口，此例为 `/custom/api/config`。也支持 `/tools/closet` 等多级路径及 `/`（对应 `/api/config`）。

## 兼容范围与实现限制

插件没有使用官方分组接口：它注册自己的侧栏行，隐藏已收纳的原行，点击代理行时打开原面板，因此依赖宿主当前 DOM、图标和标签结构。

- 插件界面目前仍为中文。英文官方行排除已在所列 Windows 环境验证，不代表已完成所有语言本地化。
- 入口按显示标签识别，同名入口不能可靠区分；入口改名或切换语言后，原归属可能需要重新分配。同名匣本身仍按各自 ID 区分。
- 菜单入口及使用宿主默认图标等被识别为官方行的入口，暂不参与收纳。
- 宿主更改侧栏结构后可能需要适配。

## 验证记录

- 23 项 Node 回归通过；运行 `npm test`。本次云端完整用例检查命令为 `node --test --test-isolation=none tests/*.test.mjs`。
- 运行代码与 Windows 已测的 0.1.3 build r2 一致，仅统一发布版本及文档。报告环境为 Windows 11 专业版 10.0.26300 x64、DSH Desktop 0.2.2-rc.1。
- Windows 报告覆盖中英文官方行排除、英文冷启动、多匣、动态启停和配置保存恢复；验证范围及指纹见 [Windows 验证摘要](WINDOWS-VALIDATION.md)。

## 文件

- `lib/index.js`：Host 配置读写与同源 JSON 接口。
- `lib/ui.js`：侧栏和设置界面。
- `lib/client.js`：空实现。
- `tests/`：配置、保存队列、前缀、动态入口、Esc 和官方行识别的回归测试。

## 许可

[MIT](LICENSE)
