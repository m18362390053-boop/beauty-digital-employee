# Requirements / 运行环境

本项目使用 **Node.js + TypeScript**，不是Python项目，因此不提供会误导安装的 `requirements.txt`。
所有运行依赖和精确解析版本见各子项目的 `package.json` 与 `package-lock.json`。

## 必需环境

- Node.js **24.x LTS**，建议24.11或同系列更新版本。使用内置 `node:sqlite`，不需额外数据库服务或GPU。
- npm，建议Node 24附带的11.x。
- 可访问仓库的Git（私有仓库需要相应访问权限）。
- Windows、macOS或Linux；验证环境为Windows PowerShell 5.1 / Node24。
- 现代浏览器，用于访问本机 `/demo/`。

## 主应用依赖

工作目录：`beauty-demo/`。

- 运行：Express、Zod、Model Context Protocol SDK。
- 开发：TypeScript、tsx、Node/Express类型。
- 浏览器验证：playwright-core，使用已安装的Edge/Chrome；不自动下载浏览器。
- 安装：`npm ci`；构建：`npm run build`；启动：`npm start`。

## 模型与可选集成

- TypeSafe API：`TYPESAFE_API_KEY`，模型 `jev-latest`。
- 回复API：`CHAT_API_KEY`、`CHAT_BASE_URL`、`CHAT_MODEL`，推荐DeepSeek官方 `deepseek-flash`。
- 密钥从服务端环境或Git忽略的本地文件读取。纯工程测试不需要密钥。
- DeepSeek Harness：可选，已验证 `@deepseek-ai/dsh@0.1.5-rc.3`。
- Harness自身的主模型连接与客服后端模型连接相互独立。

## 端口和目录

| 项目 | 默认值 |
|---|---|
| HTTP后端 | `127.0.0.1:3090`，可用PORT修改端口 |
| Harness启动器 | `127.0.0.1:3002` |
| SQLite | `beauty-demo/data/beauty.sqlite` |
| 本地运行配置 | `beauty-demo/config/local.json`（可选） |
| 业务演示配置 | `beauty-demo/config/business.demo.json` |
| 运行报告 | `beauty-demo/test-results/` |

仅运行一个访问同一数据库的后端实例。服务进程需要能写入data目录。
更新数据库或业务数据前可用 `npm run backup` 生成一致性备份。

## 网络与服务器

本地体验无需云服务器。真实模型请求需要能访问TypeSafe、DeepSeek或配置的兼容服务。
本版本默认只监听本机；公网部署需要另外配置HTTPS、访问控制和代理来源检查。
