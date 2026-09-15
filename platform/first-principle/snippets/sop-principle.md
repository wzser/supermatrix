(a) 何时用 & 约束：
- 可复用 SOP 必须锁死输入、判断、输出、幂等键、回执与异常路径；magic value 放配置。
- 多步流程每个阶段都要有可判定 evidence；pending、accepted、queued 和进程存活不能冒充终局完成。
- 外部写入只走登记的 owner/队列入口，终局 read-back 失败就保持 fail-closed，不自行补造监督层。

(b) 验收：
- 变更前后跑 lint、最小测试和一次幂等重跑；真实外部依赖不可达时只报告 blocked，不伪造成功。

(c) 完整公开原则：`full-docs/sop-principle.md`。
