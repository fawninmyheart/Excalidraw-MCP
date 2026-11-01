# Excalidraw-MCP

**在 Windows 上安装本地 Excalidraw，让你和 Codex / 其他 MCP 客户端一起编辑同一块画布。**

包含可重复运行的安装器、独立画布窗口、后台控制接口和 7 个标准 MCP 工具。无需 Excalidraw+ 账号，无需 Docker。安装后，日常绘图和 MCP 控制在本机进行。

## 把这个仓库交给 Codex

在已经安装并登录的 Codex 中发送：

> 请把 https://github.com/fawninmyheart/Excalidraw-MCP 安装到这台 Windows 电脑。先阅读仓库的 AGENTS.md 和 README.md，运行安装器，启动画布，完成 doctor 验证，并告诉我 MCP 是否已注册。保留已有 MCP 配置和画布数据。

Codex 可以克隆仓库，也可以下载 ZIP。安装器本身不需要 Git。仓库中的 [AGENTS.md](AGENTS.md) 说明了安装步骤、验证标准和共同编辑规则。

## 自己安装

下载或克隆本仓库，在仓库目录运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

默认安装到 `%LOCALAPPDATA%\Excalidraw-MCP`。安装器会：

1. 查找 Edge 或 Chrome，准备固定版本的 Node.js；需要下载 Node 时校验 SHA-256。
2. 下载并校验固定提交的 Excalidraw 源码，应用本仓库维护的 4 个文件覆盖补丁。
3. 按锁文件安装依赖，构建生产版本。
4. 创建 **Excalidraw-MCP** 桌面与开始菜单快捷方式。
5. 生成适用于当前电脑的 MCP 配置，并注册到 Codex。
6. 打开专用画布并检查网页服务、控制接口与 MCP 工具。

首次安装需要联网下载依赖和构建，可能花几分钟。重启 MCP 客户端以加载新增工具。以后双击快捷方式即可启动；窗口可以最小化，MCP 会在后台操作，不占用鼠标。

支持目标为 Windows 10/11；本仓库实际验收平台是 Windows x64。安装器也包含 Windows ARM64 的 Node 下载项，但 ARM64 尚未完成设备验收。若系统没有 Edge 或 Chrome，安装器尝试通过系统已有的 winget 安装官方 Edge；系统权限、代理或软件源限制可能需要你处理。

## 共同编辑

| 工具 | 用途 |
| --- | --- |
| `status` | 检查连接和元素数量 |
| `read_scene` | 读取场景、图片数据、元素 ID 和版本 |
| `append_elements` | 添加图形和文字，保留已有内容 |
| `update_elements` | 按 ID 增量修改或删除指定元素 |
| `replace_scene` | 明确需要时导入或重置整幅场景 |
| `export_svg` | 返回 SVG 文本 |
| `screenshot` | 返回可由客户端直接展示的 PNG 图片 |

你修改 A、Codex 修改 B，两边的内容都会保留。普通编辑使用 `append_elements` 和 `update_elements`；只有同一个目标在读取后已发生变化时，旧修改才会停止，客户端应重新读取并合并自己的改动。这不会锁住画布，也不会阻止其他图形继续编辑。

示例：

```json
{
  "updates": [
    {
      "id": "read_scene 返回的元素 ID",
      "expectedVersion": 3,
      "changes": { "x": 240, "backgroundColor": "#d3f9d8" }
    }
  ]
}
```

修改形状的标签时，更新其绑定的 text 元素。`replace_scene` 使用整幅场景的 `expectedRevision`，适合明确的导入或重置。不要自动重试失败的追加操作，先读取画布确认是否已经添加。

## 其他 harness

安装会生成 `%LOCALAPPDATA%\Excalidraw-MCP\mcp-config.json`。把其中的 `excalidraw` 条目合并到客户端的 MCP 配置中，保留原有服务器。

这是 **本机 stdio MCP**：由客户端启动 Node 进程，不新增 HTTP MCP 端口。支持 stdio 的客户端可以使用；仅支持远程 HTTP 的服务不能直接使用这个入口。Codex / Claude Code / Cursor / 自建 harness 的实际配置入口由各客户端决定。

你可用以下参数创建独立安装或跳过 Codex 注册：

```powershell
.\install.ps1 -InstallDir 'D:\Tools\Excalidraw-MCP' -AppPort 3030 -CdpPort 9230 -McpName excalidraw-work
.\install.ps1 -SkipMcpRegistration
```

同名 MCP 已指向另一套安装时，安装器会报告冲突；选择另一个 `-McpName` 即可共存。

同一安装目录的端口保持固定，以保留浏览器中的画布来源。需要换端口时使用新的 `-InstallDir`，再导出/导入画布；非默认 MCP 名称也会用于区分快捷方式。

## 数据、迁移与更新

- `data/browser` 保存专用浏览器配置、画布、图片和素材库。
- `upstream` 是下载的上游源码和构建输出。
- `tool` 是已安装的服务与 MCP 代码，运行不再依赖下载仓库所在的位置。
- `installation.json` 保存本机路径与端口，`mcp-config.json` 是为本机生成的客户端配置。
- `logs` 保存运行记录和必要的 MCP 配置备份。

这些目录都在安装目录内，不会上传到这个仓库。重复安装保留 `data`；更新前仍建议把重要画布导出成 `.excalidraw` 文件。迁移到另一台电脑时，先安装，再从 Excalidraw 菜单导入导出的文件。安装工具不会自动复制你的私人画布或浏览器配置。

网页默认监听 `127.0.0.1:3000`，浏览器控制端口为 `127.0.0.1:9228`，均仅本机访问。请使用快捷方式启动的专用窗口；日常浏览器中的另一个标签页不是 MCP 所连接的实时画布。本项目没有部署互联网多人协作服务，上游中的云分享和 AI 入口仍属于外部服务。

## 验证与排错

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\doctor.ps1
# 指定安装位置
.\doctor.ps1 -InstallDir 'D:\Tools\Excalidraw-MCP'
```

检查失败时，先打开快捷方式，确认没有同一端口上的其他部署或重复画布窗口。MCP 注册完成但客户端尚未显示工具时，重启客户端。安装中断可重新运行同一命令；校验失败的下载不会用于执行。

## 开发与来源

```powershell
npm ci
npm test
```

协议测试使用内存隔离画布，验证新旧协议握手、工具发现、增量编辑、并发冲突和输入校验，不会修改你的画布。完整 Windows 安装测试应使用独立安装目录和备用端口，且加上 `-SkipMcpRegistration -SkipShortcuts`。

上游来源是 [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw)，具体提交、下载地址和校验值记录在 [upstream-lock.json](upstream-lock.json)。覆盖补丁保留官方编辑器，只增加本机自动化桥和后台保存；这是社区项目，与 Excalidraw 官方无隶属关系。

本项目使用 MIT 许可证。Excalidraw 及依赖的许可说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
