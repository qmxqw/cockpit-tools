# 本项目智能按需编译与部署规则

## 1. 核心目标
- 本地构建**严禁生成 MSI 或 NSIS 安装包**（跳过 WiX、NSIS 打包与高耗时压缩）。
- 编译时**自动智能判断只需更新哪个 exe**，杜绝多余编译：
  - 若仅修改了 Go Sidecar（`sidecars/cockpit-cliproxy/`），**仅编译 Go Sidecar**（耗时仅 1~2 秒），严禁触发耗时的前端与 Rust 主程序编译。
  - 若仅修改了前端（`src/`）或 Rust（`src-tauri/`），**仅编译主程序**（使用 `--no-bundle`）。
  - 若两者均未发生变动，直接提示已是最新，无需编译。
- 编译生成的新二进制**自动直接输出/替换到运行目录**：
  - 目标目录：`C:\Users\jxc\AppData\Local\Cockpit Tools`
  - 产物文件：`cockpit-tools.exe` 与 `cockpit-cliproxy.exe`

## 2. 快捷部署命令
- 工作区提供自动化按需构建脚本：
  ```bash
  npm run build:deploy
  ```
  - 支持传入 `-Force` 参数进行强制全量重新编译：
    ```powershell
    npm run build:deploy -- -Force
    ```
