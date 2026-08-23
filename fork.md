# Fork 安装与更新

本 fork 的安装器和内置更新器只使用
[`jchanghong023/oh-my-pi`](https://github.com/jchanghong023/oh-my-pi) 的最新 GitHub Release，
不会通过 `omp.sh`、上游 npm 包、Homebrew 或 mise 更新到 `can1357/oh-my-pi`。

## 支持的平台

| 系统 | 架构 | Release 文件 |
| --- | --- | --- |
| Linux（glibc） | x86_64 / amd64 | `omp-linux-x64` |
| Linux（glibc） | ARM64 / aarch64 | `omp-linux-arm64` |
| Windows | x86_64 / amd64 | `omp-windows-x64.exe` |

安装器会自动识别系统和架构，不需要手动选择文件。目前不发布 macOS、Linux musl/Alpine
和 Windows ARM64 二进制。

如果 `PATH` 中已经存在官方 `omp`，安装器会先下载并验证 fork 二进制，然后直接替换当前
实际命中的官方启动器；不会把 fork 安装到另一个更靠后的目录。显式设置 `PI_INSTALL_DIR`
时，以指定目录为准。

## Linux 安装

Linux x64 和 Linux ARM64 使用同一条命令：

```sh
curl -fsSL https://raw.githubusercontent.com/jchanghong023/oh-my-pi/main/scripts/install.sh | sh
```

安装器查询本 fork 的最新 GitHub Release，并在报告成功前运行 `omp --version`。如果
`PATH` 中已有 `omp`，直接替换该启动器；否则安装到
`${PI_INSTALL_DIR:-$HOME/.local/bin}/omp`。

如果 `~/.local/bin` 不在 `PATH` 中：

```sh
export PATH="$HOME/.local/bin:$PATH"
```

需要自定义安装目录时：

```sh
curl -fsSL https://raw.githubusercontent.com/jchanghong023/oh-my-pi/main/scripts/install.sh \
  | PI_INSTALL_DIR=/usr/local/bin sh
```

## Windows 安装

在 PowerShell 中运行：

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/jchanghong023/oh-my-pi/main/scripts/install.ps1))) -Binary
```

安装器查询本 fork 的最新 GitHub Release。如果 `PATH` 中已有 `omp`，直接替换该启动器；
否则将 `omp-windows-x64.exe` 安装为 `%LOCALAPPDATA%\omp\omp.exe`，并按需把目录加入用户
`PATH`。首次安装后如果当前终端找不到 `omp`，重新打开 PowerShell。

## 更新

Linux x64、Linux ARM64 和 Windows 都使用：

```sh
omp update
```

只检查是否有更新，不安装：

```sh
omp update --check
```

强制重新安装本 fork 的最新 Release：

```sh
omp update --force
```

更新器直接查询：

```text
https://api.github.com/repos/jchanghong023/oh-my-pi/releases/latest
```

然后下载该 Release 中与当前平台匹配的文件，并使用 GitHub Release 元数据中的大小和
SHA-256 摘要验证下载。fork 二进制内嵌其 `v<版本>-fork.<构建号>` Release 标签，因此同一
上游版本下连续发布多个 fork 构建时，`omp update` 也能识别新构建。

`--canary` 不受支持；本 fork 只更新正式发布且标记为 latest 的稳定 Release。检测到
Homebrew、mise 或 Nix 管理的安装时，更新器不会调用这些上游渠道，而是提示使用本页的 fork
安装命令。

## 发布新版本

1. 将要发布的提交推送到 `main`。
2. 在 GitHub Actions 中从 `main` 手动运行 **Fork Release**。
3. 工作流构建并验证 Linux x64、Linux ARM64 和 Windows x64 二进制。
4. 工作流创建 `v<版本>-fork.<GitHub Actions 运行号>` 标签和 GitHub Release，并将其设为 latest。
5. 用户再次执行安装命令或 `omp update` 即可获得该版本。
