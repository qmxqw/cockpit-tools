export interface AutoRefreshSchedulerTask {
  key: string;
  label: string;
  intervalMs: number;
  run: () => Promise<void>;
  shouldSkip?: () => boolean;
  initialDelayMs?: number;
}

export interface AutoRefreshSchedulerOptions {
  tickMs?: number;
  maxConcurrent?: number;
}

export interface AutoRefreshSchedulerHandle {
  start: () => void;
  stop: () => void;
}

const DEFAULT_TICK_MS = 1_000;
const DEFAULT_MAX_CONCURRENT = 1;

interface RuntimeTask extends AutoRefreshSchedulerTask {
  nextRunAt: number;
  running: boolean;
}

function clampIntervalMs(intervalMs: number): number {
  return Math.max(intervalMs, DEFAULT_TICK_MS);
}

/**
 * 计算严格大于 `now` 的下一个与本地当天 00:00:00 对齐的运行时间戳。
 * 例如：intervalMs 为 10 分钟，当前为 14:23:45，则下一个对齐点为 14:30:00.000。
 */
export function getNextAlignedRunAt(intervalMs: number, now = Date.now()): number {
  if (intervalMs <= 0) {
    return now;
  }
  const date = new Date(now);
  const midnight = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    0,
    0,
    0,
    0,
  ).getTime();

  const elapsed = now - midnight;
  const remainder =
    elapsed >= 0
      ? elapsed % intervalMs
      : ((elapsed % intervalMs) + intervalMs) % intervalMs;

  if (remainder === 0) {
    return now + intervalMs;
  }
  return now + (intervalMs - remainder);
}

function resolveInitialNextRunAt(
  task: AutoRefreshSchedulerTask,
  tickMs: number,
  now = Date.now(),
): number {
  if (typeof task.initialDelayMs === 'number' && Number.isFinite(task.initialDelayMs)) {
    return now + Math.max(tickMs, Math.floor(task.initialDelayMs));
  }
  const intervalMs = clampIntervalMs(task.intervalMs);
  return getNextAlignedRunAt(intervalMs, now);
}

export function createAutoRefreshScheduler(
  tasks: AutoRefreshSchedulerTask[],
  options: AutoRefreshSchedulerOptions = {},
): AutoRefreshSchedulerHandle {
  const tickMs = Math.max(1_000, options.tickMs ?? DEFAULT_TICK_MS);
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);

  let stopped = false;
  let timerId: number | null = null;
  let activeCount = 0;

  const now = Date.now();
  const runtimeTasks: RuntimeTask[] = tasks
    .filter((task) => task.intervalMs > 0)
    .map((task) => ({
      ...task,
      nextRunAt: resolveInitialNextRunAt(task, tickMs, now),
      running: false,
    }));

  const scheduleDueTasks = () => {
    if (stopped || activeCount >= maxConcurrent) {
      return;
    }

    const currentNow = Date.now();
    const dueTasks = runtimeTasks
      .filter((task) => !task.running && task.nextRunAt <= currentNow)
      .sort((left, right) => {
        if (left.nextRunAt !== right.nextRunAt) {
          return left.nextRunAt - right.nextRunAt;
        }
        return left.key.localeCompare(right.key);
      });

    for (const task of dueTasks) {
      if (stopped || activeCount >= maxConcurrent) {
        break;
      }

      const clampedInterval = clampIntervalMs(task.intervalMs);
      if (task.shouldSkip?.()) {
        task.nextRunAt = getNextAlignedRunAt(clampedInterval, currentNow);
        continue;
      }

      task.running = true;
      task.nextRunAt = getNextAlignedRunAt(clampedInterval, currentNow);
      activeCount += 1;

      void Promise.resolve()
        .then(() => task.run())
        .finally(() => {
          task.running = false;
          activeCount = Math.max(0, activeCount - 1);
          if (!stopped) {
            scheduleDueTasks();
          }
        });
    }
  };

  return {
    start() {
      if (stopped || timerId !== null || runtimeTasks.length === 0) {
        return;
      }
      scheduleDueTasks();
      timerId = window.setInterval(scheduleDueTasks, tickMs);
    },
    stop() {
      stopped = true;
      if (timerId !== null) {
        window.clearInterval(timerId);
        timerId = null;
      }
    },
  };
}
