# Local Workbench

本机文件浏览、文本编辑和 Shell 命令执行页面。只使用 Node.js 标准库，无需安装依赖。

## 启动

```bash
./start.sh start
```

```bash
./start.sh restart
./start.sh help
```

## 更新

```bash
./update.sh
```

仅从远端更新仓库内的 `local-workbench` 目录，不会更新其他目录。若该目录有已跟踪的未提交修改，脚本会中止，避免覆盖本地工作。

需要以远端版本强制覆盖该目录时：

```bash
./update.sh force
```

`force` 会丢弃该目录的本地已跟踪改动，并删除其中未跟踪文件；被 Git 忽略的运行时文件（如日志和 PID 文件）会保留。

默认监听 `0.0.0.0:8787`；本机打开 `http://127.0.0.1:8787`，局域网设备使用本机 IP。可通过 `HOST=127.0.0.1 PORT=8788 ./start.sh start` 覆盖监听地址和端口。

## 能力

- 顶部显示当前绝对路径；目录列表支持多选和批量删除
- 统一上传菜单可选择文件或文件夹；文本可预览编辑，图片仅预览
- 文件 API 可访问当前用户有权限访问的任意本机路径；列表中的 `../` 可逐级向上导航
- Shell 流式输出，保留命令与结果历史，支持 ↑↓、Ctrl/Cmd+C、Ctrl/Cmd+L

## 自检

```bash
node --test server.test.js
```

## 边界

- 服务默认监听所有网卡；文件和 Shell 均按当前用户权限执行，只应部署在可信网络。
- 文件和 Shell 均按当前用户权限执行；这是本机可信环境工具。
- 每条命令独立启动一个 Shell；单独执行 `cd` 会同步文件列表和后续命令目录，复杂 Shell 组合中的目录切换不跨命令保留。
# local-workbench
