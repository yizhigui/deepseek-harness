# Agent Note: 恢复废弃的 Desktop 包事务

Status: implemented

[English](2026-09-21-desktop-package-lock-recovery.md) | 中文

## 问题

PID 文件无法区分被重用的 PID 与原 owner。读取已死亡 owner、删除文件再独占重建，会让两个恢复者同时进入：较晚的读取者可能删除第一个恢复者的新文件。进程死亡绕过内存回滚，可能让包元数据与 bundle 注册停在不同变更阶段。

## 决策

manager 在整个事务中持有内核保护资源。pnpm 在请求执行许可前取得独立保护资源；许可前失去父进程就退出，不导入 pnpm。获得许可后，worker 将保护资源保留到进程退出，即使 Desktop 先死亡。获取 ownership 时先取得 manager 保护资源，再证明 worker 保护资源可用，然后解释持久 owner 信息。延迟且未获许可的 worker 不能写包。

Windows 使用 Node 独占命名管道监听器，以 profile 保护路径的规范化、小写哈希命名。Libuv 独占绑定首个实例；进程死亡会删除监听器。POSIX 在稳定的相邻保护文件上复用已发布 native-system 非阻塞 flock，验证 inode 标识，重置不删除这些文件。ownership 不依赖年龄阈值。owner JSON 包含用于诊断的 schemaVersion、manager pid、token 和可选 workerPid。两种保护资源均空闲证明合法新格式记录已废弃，不受 PID 重用影响。旧版仅含 PID 的记录缺少身份信息，因此只有 ESRCH 允许迁移；损坏记录和未知存活状态保守拒绝。参见 [Node IPC 语义](https://nodejs.org/api/net.html#ipc-support)和 [libuv Windows bind](https://github.com/libuv/libuv/blob/v1.x/src/win/pipe.c)。

包变更在解除宿主链接前，原子持久化已有 manifest/lockfile 快照。启动通过异常回滚使用的同一 restorePackages/finishPackageOperation 路径恢复。准备先移除 pending，再通过删除快照提交，之后重启 backend。提交前 crash 恢复旧图，提交后 crash 保留新图。恢复失败保留快照供重试。仅有 pending 而无快照时，沿用 frozen installation、rebuild 和 validation。pending 表示准备状态，不表示 ownership。

本决策部分取代[原地 profile 决策](../architecture/2026-09-09-desktop-in-place-profile.zh.md)和[直接启动决策](../architecture/2026-09-09-desktop-immediate-window-and-direct-start.zh.md)中的失败处理。这些记录仍保留不使用 staging 和窗口生命周期的理由。不引入包目录复制、第二套恢复引擎或 backend shutdown 修改。

## 考虑过的替代方案

**仅使用 PID 加创建时间**能更准确地识别进程，但不能串行化旧锁删除者，也无法覆盖 pnpm 启动到信息发布之间的窗口。内核保护资源直接解决 ownership，无需额外进程检查 API。

**可过期锁文件**可能抢占合法的长时间安装。无响应但仍存活的 owner 在退出前继续独占。

**只删除 ownership 而不恢复元数据**会让中断的 add/remove 留下不一致的 manifest、lockfile 和 bundles。持久化既有的小型回滚快照，保留原恢复路径而不复制 profile。

## 后果

新格式废弃事务自动恢复；有歧义且 PID 存活的旧记录仍需要实际 owner 退出，或由操作者另行取得证据。POSIX 保护文件以 inode 形式保留，不表示活跃事务。内联 bootstrap 让上游 Node 无需读取 Electron app.asar 即可运行 pnpm，并保持直接 CLI 的 worker-thread 启动语义。确定性子进程屏障覆盖 owner 死亡、存活 worker、同时恢复、损坏信息、恢复失败及后续操作。已安装 Windows Electron 的 crash/restart 仍属于发布验收。
