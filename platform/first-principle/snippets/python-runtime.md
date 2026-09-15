(a) 何时用 & 约束：
- 持久化 Python 入口要求 Python 3.11.15，兼容范围 `>=3.11,<3.12`；由 `FP_PYTHON` 指向实际解释器。
- 命令必须显式调用 `"$FP_PYTHON"`，不依赖裸 `python`、`python3` 或系统 PATH 的隐式选择。
- 测试回执必须包含 `FP_PYTHON` 的绝对路径与完整 `python --version` 输出。

(b) 路径：
- 默认静态配置在本 bundle 内；运行状态另放 `FP_STATE_DIR`，不复制 runtime DB、Keychain 或授权文件。

(c) 完整公开原则：`full-docs/python-runtime.md`。
