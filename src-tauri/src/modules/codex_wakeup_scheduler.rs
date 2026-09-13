use crate::modules::{codex_account, codex_wakeup, logger};
use chrono::{DateTime, Datelike, Local, TimeZone};
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::AppHandle;
use tokio::time::sleep;

static STARTED: OnceLock<Mutex<bool>> = OnceLock::new();
static RUNNING_TASKS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static STARTUP_TRIGGERED: OnceLock<Mutex<bool>> = OnceLock::new();

fn started_flag() -> &'static Mutex<bool> {
    STARTED.get_or_init(|| Mutex::new(false))
}

fn running_tasks() -> &'static Mutex<HashSet<String>> {
    RUNNING_TASKS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn startup_triggered_flag() -> &'static Mutex<bool> {
    STARTUP_TRIGGERED.get_or_init(|| Mutex::new(false))
}

fn lock_or_recover<'a, T>(mutex: &'a Mutex<T>, label: &str) -> std::sync::MutexGuard<'a, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(err) => {
            logger::log_warn(&format!(
                "[CodexWakeup] 检测到锁中毒，继续使用恢复数据: {}",
                label
            ));
            err.into_inner()
        }
    }
}

fn parse_time_to_minutes(value: &str) -> Option<i32> {
    let parts: Vec<&str> = value.trim().split(':').collect();
    if parts.len() != 2 {
        return None;
    }
    let hour: i32 = parts[0].parse().ok()?;
    let minute: i32 = parts[1].parse().ok()?;
    if !(0..=23).contains(&hour) || !(0..=59).contains(&minute) {
        return None;
    }
    Some(hour * 60 + minute)
}

fn build_local_datetime(date: chrono::NaiveDate, minutes: i32) -> Option<DateTime<Local>> {
    let hour = (minutes / 60) as u32;
    let minute = (minutes % 60) as u32;
    Local
        .with_ymd_and_hms(date.year(), date.month(), date.day(), hour, minute, 0)
        .earliest()
        .or_else(|| {
            Local
                .with_ymd_and_hms(date.year(), date.month(), date.day(), hour, minute, 0)
                .latest()
        })
}

fn collect_task_reset_timestamps(task: &codex_wakeup::CodexWakeupTask) -> Vec<i64> {
    if task.account_ids.is_empty() {
        return Vec::new();
    }
    let quota_reset_window = task
        .schedule
        .quota_reset_window
        .as_deref()
        .unwrap_or("either");
    let include_primary = quota_reset_window == "either" || quota_reset_window == "primary_window";
    let include_secondary =
        quota_reset_window == "either" || quota_reset_window == "secondary_window";

    let selected: HashSet<&str> = task.account_ids.iter().map(String::as_str).collect();
    let mut timestamps: Vec<i64> = codex_account::list_accounts()
        .into_iter()
        .filter(|account| selected.contains(account.id.as_str()))
        .flat_map(|account| account.quota.into_iter())
        .flat_map(|quota| {
            let mut values = Vec::new();
            if include_primary {
                values.push(quota.hourly_reset_time);
            }
            if include_secondary {
                values.push(quota.weekly_reset_time);
            }
            values
        })
        .flatten()
        .filter(|ts| *ts > 0)
        .collect();
    timestamps.sort_unstable();
    timestamps.dedup();
    timestamps
}

#[inline]
fn is_special_schedule_active_today(name: &str, today: chrono::NaiveDate) -> bool {
    let b = name.trim().as_bytes();
    if b.len() != 3 && b.len() != 2 {
        return true;
    }
    let num = match b.len() {
        3 if b[1].is_ascii_digit() && b[2].is_ascii_digit() => {
            (b[1] - b'0') as u32 * 10 + (b[2] - b'0') as u32
        }
        2 if b[1].is_ascii_digit() => (b[1] - b'0') as u32,
        _ => return true,
    };
    match b[0] {
        b'd' | b'D' if (1..=31).contains(&num) => today.day() == num,
        b'w' | b'W' if (1..=7).contains(&num) => today.weekday().number_from_monday() == num,
        _ => true,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopTaskSpec {
    pub date_str: String,
    pub last_index: usize,
    pub batch_size: usize,
}

pub fn parse_loop_task_spec(name: &str) -> Option<LoopTaskSpec> {
    let trimmed = name.trim();
    let lower = trimmed.to_ascii_lowercase();
    if !lower.starts_with("loop_") {
        return None;
    }
    let parts: Vec<&str> = trimmed.split('_').collect();
    if parts.len() != 4 {
        return None;
    }
    let date_str = parts[1].trim().to_string();
    if date_str.is_empty() {
        return None;
    }
    let last_index = parts[2].trim().parse::<usize>().ok()?;
    let batch_size = parts[3].trim().parse::<usize>().ok()?.max(1);

    Some(LoopTaskSpec {
        date_str,
        last_index,
        batch_size,
    })
}

pub fn is_loop_task_done_today(spec: &LoopTaskSpec, today: chrono::NaiveDate) -> bool {
    if spec.date_str == "0" || spec.date_str == "0000" {
        return false;
    }
    let today_mmdd = today.format("%m%d").to_string();
    let today_dd = format!("{:02}", today.day());
    let today_d_single = today.day().to_string();

    spec.date_str == today_mmdd || spec.date_str == today_dd || spec.date_str == today_d_single
}

fn load_quota_pool_state_map() -> HashMap<String, serde_json::Value> {
    let mut map = HashMap::new();
    let Ok(data_dir) = crate::modules::account::get_data_dir() else {
        return map;
    };
    let path = data_dir
        .join("codex_local_access_sidecar")
        .join("quota-pool-state.json");
    if !path.exists() {
        return map;
    }
    let Ok(content) = std::fs::read_to_string(&path) else {
        return map;
    };
    let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) else {
        return map;
    };
    if let Some(obj) = val.get("accounts").and_then(|a| a.as_object()) {
        for (k, v) in obj {
            map.insert(k.clone(), v.clone());
        }
    }
    map
}

pub fn is_account_eligible_for_wakeup(
    account_id: &str,
    pool_map: &HashMap<String, serde_json::Value>,
    now_ts: i64,
) -> bool {
    let Some(info) = pool_map.get(account_id) else {
        // 在配额池中无记录（纯新账号/从未开窗），符合资格
        return true;
    };
    let Some(primary) = info.get("primary").and_then(|p| p.as_object()) else {
        // 无主配额窗口，符合资格
        return true;
    };
    if primary.get("present").and_then(|p| p.as_bool()) != Some(true) {
        return true;
    }

    let reset_at = primary.get("resetAt").and_then(|r| r.as_i64()).unwrap_or(0);
    // 条件 1：已经重置了额度（到期）
    if reset_at <= now_ts {
        return true;
    }

    // 条件 2：未开启倒计时（满血且时钟流逝 <= 60s）
    let remaining_pct = primary.get("remainingPercent").and_then(|p| p.as_i64()).unwrap_or(0);
    if remaining_pct == 100 {
        let updated_at = info.get("updatedAt").and_then(|u| u.as_i64()).unwrap_or(0);
        let window_minutes = primary.get("windowMinutes").and_then(|w| w.as_i64()).unwrap_or(43200);
        let window_sec = window_minutes * 60;
        let elapsed = window_sec - (reset_at - updated_at);
        if elapsed.abs() <= 60 {
            return true;
        }
    }

    false
}

pub fn get_global_sorted_accounts() -> Vec<crate::models::codex::CodexAccount> {
    let mut accounts = codex_account::list_accounts();
    accounts.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    accounts
}

pub fn select_loop_accounts(spec: &LoopTaskSpec) -> Vec<String> {
    let accounts = get_global_sorted_accounts();
    if accounts.is_empty() {
        return Vec::new();
    }
    let total = accounts.len();

    if spec.last_index == 0 {
        // 模式 1：X == 0，从全局只获取符合条件的账号，按创建时间升序取最早的
        let pool_map = load_quota_pool_state_map();
        let now_ts = chrono::Local::now().timestamp();

        let eligible: Vec<String> = accounts
            .into_iter()
            .filter(|acc| is_account_eligible_for_wakeup(&acc.id, &pool_map, now_ts))
            .map(|acc| acc.id)
            .collect();

        eligible.into_iter().take(spec.batch_size).collect()
    } else {
        // 模式 2：X > 0，从指定的序号下一个开始提取 Y 个
        let count = spec.batch_size.min(total);
        let mut selected = Vec::with_capacity(count);
        for i in 0..count {
            let idx = (spec.last_index + i) % total;
            selected.push(accounts[idx].id.clone());
        }
        selected
    }
}

pub fn next_loop_task_name(
    name: &str,
    processed_count: usize,
    today: chrono::NaiveDate,
) -> Option<String> {
    let spec = parse_loop_task_spec(name)?;
    let total_accounts = get_global_sorted_accounts().len();
    if total_accounts == 0 || processed_count == 0 {
        return None;
    }
    let today_mmdd = today.format("%m%d").to_string();
    if spec.last_index == 0 {
        // 模式 1：X == 0，保持 X 为 0，不维护序号
        Some(format!("LOOP_{}_0_{}", today_mmdd, spec.batch_size))
    } else {
        // 模式 2：X > 0，增加游标
        let new_index = ((spec.last_index + processed_count - 1) % total_accounts) + 1;
        Some(format!("LOOP_{}_{}_{}", today_mmdd, new_index, spec.batch_size))
    }
}

pub fn evaluate_loop_task_name_after_run(
    name: &str,
    records: &[codex_wakeup::CodexWakeupHistoryItem],
    history: &[codex_wakeup::CodexWakeupHistoryItem],
    today: chrono::NaiveDate,
) -> Option<String> {
    let _spec = parse_loop_task_spec(name)?;
    if records.is_empty() {
        return None;
    }

    let failed_records: Vec<&codex_wakeup::CodexWakeupHistoryItem> =
        records.iter().filter(|r| !r.success).collect();

    if failed_records.is_empty() {
        // 全部成功：保持当前逻辑，改名，今日不再运行
        return next_loop_task_name(name, records.len(), today);
    }

    // 有失败的账号：检查触发历史
    // 排除今天，只看今天之前的 3 个自然日
    let today_start = build_local_datetime(today, 0)?.timestamp();
    let three_days_prior_start = today_start - 3 * 86400;

    let has_first_time_failure = failed_records.iter().any(|failed_item| {
        let had_prior_failure = history.iter().any(|h| {
            h.account_id == failed_item.account_id
                && h.timestamp >= three_days_prior_start
                && h.timestamp < today_start
                && !h.success
        });
        !had_prior_failure
    });

    if has_first_time_failure {
        // 如果是 3 天内的首次失败，今日之内还要继续重试（不改名，保留原游标与旧日期）
        None
    } else {
        // 否则（3 天内再次失败）：保持当前逻辑，改名，今日不再运行
        next_loop_task_name(name, records.len(), today)
    }
}

fn current_due_at(task: &codex_wakeup::CodexWakeupTask, now: DateTime<Local>) -> Option<i64> {
    if let Some(spec) = parse_loop_task_spec(&task.name) {
        if is_loop_task_done_today(&spec, now.date_naive()) {
            return None;
        }
        if task.schedule.kind == "daily" {
            let minutes = parse_time_to_minutes(task.schedule.daily_time.as_deref().unwrap_or("00:00"))?;
            let candidate = build_local_datetime(now.date_naive(), minutes)?.timestamp();
            if candidate > now.timestamp() {
                return None;
            }
            let last_run = task.last_run_at.unwrap_or(0);
            if last_run < candidate {
                return Some(candidate);
            }
            // 今日已执行过但未完成（首次失败，今日需继续重试）：间隔 30 分钟重试
            let retry_due = last_run + 30 * 60;
            if now.timestamp() >= retry_due {
                return Some(retry_due);
            } else {
                return None;
            }
        } else if task.schedule.kind == "interval" {
            let interval_seconds =
                i64::from(task.schedule.interval_hours.unwrap_or(4).max(1)) * 3600;
            let due_at = task.last_run_at.unwrap_or(task.created_at) + interval_seconds;
            if due_at <= now.timestamp() {
                return Some(due_at);
            } else {
                return None;
            }
        }
        return Some(now.timestamp());
    }

    match task.schedule.kind.as_str() {
        "daily" => {
            let minutes = parse_time_to_minutes(task.schedule.daily_time.as_deref()?)?;
            let candidate = build_local_datetime(now.date_naive(), minutes)?.timestamp();
            if candidate <= now.timestamp() && task.last_run_at.unwrap_or(0) < candidate {
                Some(candidate)
            } else {
                None
            }
        }
        "weekly" => {
            let minutes = parse_time_to_minutes(task.schedule.weekly_time.as_deref()?)?;
            let weekday = now.weekday().num_days_from_sunday() as i32;
            if !task.schedule.weekly_days.contains(&weekday) {
                return None;
            }
            let candidate = build_local_datetime(now.date_naive(), minutes)?.timestamp();
            if candidate <= now.timestamp() && task.last_run_at.unwrap_or(0) < candidate {
                Some(candidate)
            } else {
                None
            }
        }
        "interval" => {
            if !is_special_schedule_active_today(&task.name, now.date_naive()) {
                return None;
            }
            let interval_seconds =
                i64::from(task.schedule.interval_hours.unwrap_or(4).max(1)) * 3600;
            let due_at = task.last_run_at.unwrap_or(task.created_at) + interval_seconds;
            if due_at <= now.timestamp() {
                Some(due_at)
            } else {
                None
            }
        }
        "quota_reset" => {
            let last_run_at = task.last_run_at.unwrap_or(task.created_at);
            collect_task_reset_timestamps(task)
                .into_iter()
                .filter(|reset_at| *reset_at <= now.timestamp() && *reset_at > last_run_at)
                .max()
        }
        "startup" => None,
        _ => None,
    }
}

pub fn calculate_next_run_at(task: &codex_wakeup::CodexWakeupTask) -> Option<i64> {
    let now = Local::now();
    if let Some(spec) = parse_loop_task_spec(&task.name) {
        let today = now.date_naive();
        if is_loop_task_done_today(&spec, today) {
            let tomorrow = today + chrono::Duration::days(1);
            let minutes = if task.schedule.kind == "daily" {
                parse_time_to_minutes(task.schedule.daily_time.as_deref().unwrap_or("00:00")).unwrap_or(0)
            } else {
                0
            };
            return build_local_datetime(tomorrow, minutes).map(|d| d.timestamp());
        } else {
            if task.schedule.kind == "daily" {
                if let Some(minutes) = parse_time_to_minutes(task.schedule.daily_time.as_deref().unwrap_or("00:00")) {
                    if let Some(candidate) = build_local_datetime(today, minutes) {
                        if candidate.timestamp() > now.timestamp() {
                            return Some(candidate.timestamp());
                        }
                        let last_run = task.last_run_at.unwrap_or(0);
                        if last_run >= candidate.timestamp() {
                            return Some(last_run + 30 * 60);
                        }
                    }
                }
            } else if task.schedule.kind == "interval" {
                let interval_seconds =
                    i64::from(task.schedule.interval_hours.unwrap_or(4).max(1)) * 3600;
                return Some(task.last_run_at.unwrap_or(task.created_at) + interval_seconds);
            }
            return Some(now.timestamp());
        }
    }

    match task.schedule.kind.as_str() {
        "daily" => {
            let minutes = parse_time_to_minutes(task.schedule.daily_time.as_deref()?)?;
            for offset in 0..7 {
                let date = now.date_naive() + chrono::Duration::days(offset);
                let candidate = build_local_datetime(date, minutes)?.timestamp();
                if candidate > now.timestamp() {
                    return Some(candidate);
                }
            }
            None
        }
        "weekly" => {
            let minutes = parse_time_to_minutes(task.schedule.weekly_time.as_deref()?)?;
            for offset in 0..14 {
                let date = now.date_naive() + chrono::Duration::days(offset);
                let weekday = date.weekday().num_days_from_sunday() as i32;
                if !task.schedule.weekly_days.contains(&weekday) {
                    continue;
                }
                let candidate = build_local_datetime(date, minutes)?.timestamp();
                if candidate > now.timestamp() {
                    return Some(candidate);
                }
            }
            None
        }
        "interval" => {
            let interval_seconds =
                i64::from(task.schedule.interval_hours.unwrap_or(4).max(1)) * 3600;
            let candidate = task.last_run_at.unwrap_or(task.created_at) + interval_seconds;
            let dt = match Local.timestamp_opt(candidate, 0).single() {
                Some(dt) => dt,
                None => return Some(candidate),
            };
            if is_special_schedule_active_today(&task.name, dt.date_naive()) {
                return Some(candidate);
            }
            for offset in 1..=65 {
                let next_date = dt.date_naive() + chrono::Duration::days(offset);
                if is_special_schedule_active_today(&task.name, next_date) {
                    return build_local_datetime(next_date, 0).map(|d| d.timestamp());
                }
            }
            None
        }
        "quota_reset" => collect_task_reset_timestamps(task)
            .into_iter()
            .filter(|reset_at| *reset_at > now.timestamp())
            .min(),
        "startup" => None,
        _ => None,
    }
}

fn mark_running(task_id: &str) -> bool {
    let mut guard = lock_or_recover(running_tasks(), "codex wakeup running tasks lock");
    guard.insert(task_id.to_string())
}

fn unmark_running(task_id: &str) {
    let mut guard = lock_or_recover(running_tasks(), "codex wakeup running tasks lock");
    guard.remove(task_id);
}

pub async fn run_task_now(
    app: Option<&AppHandle>,
    task_id: &str,
    trigger_type: &str,
    run_id: Option<String>,
) -> Result<codex_wakeup::CodexWakeupBatchResult, String> {
    let task =
        codex_wakeup::get_task(task_id)?.ok_or_else(|| format!("唤醒任务不存在: {}", task_id))?;
    if !mark_running(&task.id) {
        return Err("该任务正在执行中".to_string());
    }

    let context = codex_wakeup::TaskRunContext {
        trigger_type: trigger_type.to_string(),
        task_id: Some(task.id.clone()),
        task_name: Some(task.name.clone()),
    };
    let target_account_ids = if let Some(spec) = parse_loop_task_spec(&task.name) {
        select_loop_accounts(&spec)
    } else {
        task.account_ids.clone()
    };
    let result = codex_wakeup::run_batch(
        app,
        target_account_ids,
        task.prompt.clone(),
        codex_wakeup::CodexWakeupExecutionConfig {
            model: task.model.clone(),
            model_display_name: task.model_display_name.clone(),
            model_reasoning_effort: task.model_reasoning_effort.clone(),
        },
        context,
        run_id,
        None,
    )
    .await;

    if let Ok(batch) = &result {
        if let Err(err) = codex_wakeup::update_task_after_run(&task.id, &batch.records) {
            logger::log_warn(&format!("[CodexWakeup] 更新任务执行结果失败: {}", err));
        }
    }

    unmark_running(&task.id);
    result
}

pub async fn run_enabled_tasks_now(
    app: Option<&AppHandle>,
    trigger_type: &str,
) -> Result<u32, String> {
    let state = codex_wakeup::load_state_for_scheduler()?;
    if !state.enabled {
        return Ok(0);
    }

    let normalized_trigger = {
        let trimmed = trigger_type.trim();
        if trimmed.is_empty() {
            "startup"
        } else {
            trimmed
        }
    };

    if normalized_trigger == "startup" {
        let app_handle = app.cloned();
        let startup_tasks: Vec<(String, i32)> = state
            .tasks
            .into_iter()
            .filter(|task| task.enabled && task.schedule.kind == "startup")
            .map(|task| {
                (
                    task.id,
                    task.schedule.startup_delay_minutes.unwrap_or(0).max(0),
                )
            })
            .collect();

        for (task_id, delay_minutes) in &startup_tasks {
            let task_id = task_id.clone();
            let app_handle = app_handle.clone();
            let delay_seconds = (*delay_minutes as u64) * 60;
            tauri::async_runtime::spawn(async move {
                if delay_seconds > 0 {
                    sleep(Duration::from_secs(delay_seconds)).await;
                }

                let current_state = match codex_wakeup::load_state_for_scheduler() {
                    Ok(state) => state,
                    Err(err) => {
                        logger::log_warn(&format!(
                            "[CodexWakeup] 读取启动后任务状态失败: task_id={}, error={}",
                            task_id, err
                        ));
                        return;
                    }
                };
                let should_run = current_state.enabled
                    && current_state.tasks.iter().any(|task| {
                        task.id == task_id && task.enabled && task.schedule.kind == "startup"
                    });
                if !should_run {
                    return;
                }

                if let Err(err) = run_task_now(app_handle.as_ref(), &task_id, "startup", None).await
                {
                    logger::log_warn(&format!(
                        "[CodexWakeup] 启动后执行任务失败: task_id={}, error={}",
                        task_id, err
                    ));
                }
            });
        }
        return Ok(startup_tasks.len() as u32);
    }

    let mut started_count: u32 = 0;
    for task in state.tasks {
        if !task.enabled || task.schedule.kind == "startup" {
            continue;
        }

        match run_task_now(app, &task.id, normalized_trigger, None).await {
            Ok(_) => {
                started_count += 1;
            }
            Err(err) => {
                logger::log_warn(&format!(
                    "[CodexWakeup] 执行任务失败: task_id={}, error={}",
                    task.id, err
                ));
            }
        }
    }

    Ok(started_count)
}

pub fn trigger_startup_tasks_if_needed(app: AppHandle) {
    let state = match codex_wakeup::load_state_for_scheduler() {
        Ok(state) => state,
        Err(err) => {
            logger::log_warn(&format!("[CodexWakeup] 读取启动任务状态失败: {}", err));
            return;
        }
    };
    let has_startup_tasks = state
        .tasks
        .iter()
        .any(|task| task.enabled && task.schedule.kind == "startup");
    if !state.enabled || !has_startup_tasks {
        return;
    }

    let should_trigger = {
        let mut startup_triggered = lock_or_recover(
            startup_triggered_flag(),
            "codex wakeup startup trigger lock",
        );
        if *startup_triggered {
            false
        } else {
            *startup_triggered = true;
            true
        }
    };
    if !should_trigger {
        return;
    }

    tauri::async_runtime::spawn(async move {
        match run_enabled_tasks_now(Some(&app), "startup").await {
            Ok(started) => {
                if started > 0 {
                    logger::log_info(&format!(
                        "[CodexWakeup] 应用启动触发自启任务: started={}",
                        started
                    ));
                }
            }
            Err(err) => {
                logger::log_warn(&format!("[CodexWakeup] 应用启动触发自启任务失败: {}", err));
            }
        }
    });
}

async fn run_scheduler_once(app: &AppHandle) {
    let state = match codex_wakeup::load_state_for_scheduler() {
        Ok(state) => state,
        Err(err) => {
            logger::log_warn(&format!("[CodexWakeup] 读取任务状态失败: {}", err));
            return;
        }
    };

    if !state.enabled {
        return;
    }

    let now = Local::now();
    let today = now.date_naive();
    for task in state.tasks {
        if !task.enabled {
            continue;
        }
        // 尽早判断：仅针对 LOOP 任务，若今日已完成则直接跳过
        if let Some(spec) = parse_loop_task_spec(&task.name) {
            if is_loop_task_done_today(&spec, today) {
                continue;
            }
        }
        // 尽早判断：仅针对 interval 任务，若不符合今日生效条件则直接跳过，零性能损耗
        if task.schedule.kind == "interval" && !is_special_schedule_active_today(&task.name, today) {
            continue;
        }
        if current_due_at(&task, now).is_none() {
            continue;
        }

        let task_id = task.id.clone();
        let trigger_type = if task.schedule.kind == "quota_reset" {
            "quota_reset"
        } else {
            "scheduled"
        }
        .to_string();
        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let result = run_task_now(Some(&app_handle), &task_id, &trigger_type, None).await;
            if let Err(err) = result {
                logger::log_warn(&format!(
                    "[CodexWakeup] 调度任务执行失败: task_id={}, error={}",
                    task_id, err
                ));
            }
        });
    }
}

pub fn ensure_started(app: AppHandle) {
    let mut started = lock_or_recover(started_flag(), "codex wakeup scheduler started lock");
    if *started {
        return;
    }
    *started = true;

    tauri::async_runtime::spawn(async move {
        loop {
            run_scheduler_once(&app).await;
            sleep(Duration::from_secs(30)).await;
        }
    });
}





