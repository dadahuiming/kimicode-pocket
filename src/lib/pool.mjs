// worker 池调度器：可注入 Worker 工厂，便于**直接**测试真实调度逻辑。
//
// 为什么单独拆出来：调度器里那些保命逻辑（消息 id 校验、退出回收、
// 超时销毁）走的都是「异常时序」——超时、迟到、自杀。而真实图片处理
// 几乎不会超过 20 秒，所以端到端测试**永远走不到这些分支**。
// 实测证据：把 `msg.id !== job.id` 这行删掉，端到端测试照样全绿。
//
// 拆出来之后，测试可以注入一个「可控时序」的假 worker，
// 精确复现「A 超时 → 派 B → A 的结果迟到」，并且跑的就是生产代码。

/**
 * @param {object} opts
 * @param {() => any} opts.spawnWorker 创建 worker（需有 on/postMessage/terminate/ref/unref）
 * @param {number} [opts.poolSize]
 * @param {number} [opts.timeoutMs] 单任务超时
 * @param {(msg:any)=>void} [opts.onSettle] 任务 settle 后的回调（用于 unref 等）
 */
export function createPool({ spawnWorker, poolSize = 2, timeoutMs = 20_000, onSettle } = {}) {
  const pool = [];
  const queue = [];
  let seq = 0;

  function spawn() {
    const worker = spawnWorker();
    const slot = { worker, busy: false, dead: false, unrefed: false };

    worker.on('message', (msg) => {
      const job = worker.__current;
      // 超时后迟到的结果绝不能投给「下一个」任务。
      // 旧实现只有一个 __current 指针：超时把指针清空后立刻派新任务，
      // 而旧任务其实还在 worker 里算；算完 postMessage 回来时 __current
      // 已经指向新任务 —— 于是 B 拿到了 A 的图片。
      // 实测：A 超时(20s) → B 派发 → A 的结果到达 → B 返回 A 的图，
      // 响应仍是 200，日志里完全看不出来。
      if (!job || msg?.id !== job.id) return;
      worker.__current = null;
      slot.busy = false;
      clearTimeout(job.timer);
      job.resolve(msg);
      releaseSlotRef(slot);
      pump();
    });

    const fail = (err) => {
      if (slot.dead) return;
      slot.dead = true;
      const job = worker.__current;
      worker.__current = null;
      slot.busy = false;
      if (job) {
        clearTimeout(job.timer);
        job.resolve({ ok: false, error: String(err) });
      }
      const i = pool.indexOf(slot);
      if (i >= 0) pool.splice(i, 1);
      try {
        worker.terminate?.();
      } catch {
        /* ignore */
      }
      pump();
    };

    worker.on('error', fail);
    // **任何**退出都要回收 slot，包括 code 0。
    // 旧代码写的是 `if (code !== 0 && worker.__current) fail(...)`：
    // worker 自己 exit(0)（idleTimer 到点 / parentPort close）时主线程
    // 什么都不做，slot 留在 pool 里但线程已经没了。之后往死 worker
    // postMessage **不会抛错、会静默成功**（实测），消息再也没人处理：
    // 任务只能等满 20s 超时兜底，然后降级主线程同步处理。
    // 线上必然发生（idleTimer 就是 30 秒）：
    // 实测 4 个 worker 全自杀后，每张图 20007 / 20006 / 20012ms。
    worker.on('exit', (code) => fail(`worker exit ${code}`));

    worker.unref?.();
    slot.unrefed = true;
    return slot;
  }

  function releaseSlotRef(slot) {
    if (!slot.unrefed) {
      slot.worker.unref?.();
      slot.unrefed = true;
    }
  }

  function pump() {
    while (queue.length > 0) {
      // 池子被 worker 死亡消耗掉时补回来（否则并发度永久下降）
      if (pool.length < poolSize) pool.push(spawn());
      const slot = pool.find((s) => !s.busy && !s.dead);
      if (!slot) return;
      const job = queue.shift();
      slot.busy = true;
      slot.worker.__current = job;
      // 派活期间必须 ref，否则 Node 22 会认为事件循环已空、把 await 判失败
      if (slot.unrefed) {
        slot.worker.ref?.();
        slot.unrefed = false;
      }
      job.timer = setTimeout(() => {
        if (slot.worker.__current !== job) return;
        slot.worker.__current = null;
        slot.busy = false;
        clearTimeout(job.timer);
        // **必须杀掉这个 worker**：留着它，那次超时的计算还在跑，
        // 算完的结果会晚到（虽然 id 校验能挡住错投），
        // 而且它已经证明 20 秒算不完一张图，继续用只会继续超时。
        const i = pool.indexOf(slot);
        if (i >= 0) pool.splice(i, 1);
        slot.dead = true;
        try {
          slot.worker.terminate?.();
        } catch {
          /* ignore */
        }
        job.resolve({ ok: false, error: 'timeout' });
        pump();
      }, timeoutMs);
      job.timer.unref?.();
      slot.worker.postMessage({ id: job.id, url: job.url, opts: job.opts });
    }
  }

  function ensure() {
    if (pool.length > 0) return;
    for (let i = 0; i < poolSize; i += 1) pool.push(spawn());
    pump();
  }

  return {
    /**
     * 提交一个任务。resolve 的值来自 worker 的 msg，
     * 或 {ok:false, error} （超时 / worker 挂掉）。
     */
    submit(url, opts) {
      return new Promise((resolve) => {
        queue.push({ id: (seq += 1), url, opts, resolve });
        ensure();
        pump();
      });
    },
    stats: () => ({
      poolSize: pool.length,
      busy: pool.filter((s) => s.busy).length,
      queued: queue.length,
    }),
    /** 关池：terminate 所有 worker 并清空 */
    async shutdown() {
      // 排队中的任务必须 resolve 掉，不能直接丢弃 ——
      // 这些 promise 已经通过 submit() 交给调用方了，
      // 丢队列等于让调用方永久挂起（await 永远不 settle）。
      const pending = queue.splice(0, queue.length);
      for (const job of pending) {
        clearTimeout(job.timer);
        job.resolve({ ok: false, error: 'pool shutdown' });
      }
      // 正在跑的任务同样要 settle（worker 马上就没了）
      const all = pool.splice(0, pool.length);
      for (const s of all) {
        s.dead = true;
        const job = s.worker.__current;
        s.worker.__current = null;
        if (job) {
          clearTimeout(job.timer);
          job.resolve({ ok: false, error: 'pool shutdown' });
        }
        try {
          s.worker.terminate?.();
        } catch {
          /* ignore */
        }
      }
      onSettle?.();
    },
  };
}
