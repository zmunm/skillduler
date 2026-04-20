#!/usr/bin/env node

import { type ChildProcess, exec } from 'node:child_process'
import { existsSync, readFileSync, watch } from 'node:fs'
import path from 'node:path'
import cron from 'node-cron'
import { parse as parseYaml } from 'yaml'

interface Job {
  name: string
  description: string
  cron: string
  command?: string
  prompt?: string
  notify?: string
  telegram_bot_token?: string
  telegram_chat_id?: string
  timeout_ms?: number
  enabled: boolean
}

interface Config {
  prompt_template?: string
  timezone?: string
  telegram_bot_token?: string
  telegram_chat_id?: string
  default_timeout_ms?: number
}

const FALLBACK_TIMEOUT_MS = 600_000

interface JobsConfig {
  config?: Config
  jobs: Job[]
}

const ROOT_DIR = path.resolve(import.meta.dirname, '..')
const JOBS_FILE = path.join(ROOT_DIR, 'jobs.yaml')

function loadConfig(): { config: Config; jobs: Job[] } {
  const raw = readFileSync(JOBS_FILE, 'utf-8')
  const parsed = parseYaml(raw) as JobsConfig

  const validJobs: Job[] = []
  for (const [i, job] of (parsed.jobs ?? []).entries()) {
    if (!job.name || !job.cron) {
      console.error(
        `[loadConfig] jobs[${i}]: missing required field (name=${job.name ?? 'undefined'}, cron=${job.cron ?? 'undefined'}) — skipped`,
      )
      continue
    }
    if (job.enabled) {
      validJobs.push(job)
    }
  }

  return {
    config: parsed.config || {},
    jobs: validJobs,
  }
}

function resolvePromptPath(promptPath: string): string {
  const fullPath = path.resolve(ROOT_DIR, promptPath)
  if (!existsSync(fullPath)) {
    throw new Error(`Prompt file not found: ${fullPath}`)
  }
  return fullPath
}

const TELEGRAM_MAX_LENGTH = 4000

async function sendTelegram(
  text: string,
  botToken: string,
  chatId: string,
  retries = 3,
): Promise<boolean> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`
  const body = JSON.stringify({
    chat_id: chatId,
    text,
    disable_notification: true,
  })

  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(15000),
      })
      if (res.ok) return true
    } catch {
      if (i < retries - 1) {
        await new Promise((r) => setTimeout(r, 2000 * (i + 1)))
      }
    }
  }
  return false
}

function notifyTelegram(
  config: Config,
  job: Job,
  result: string,
): Promise<void> {
  const botToken = job.telegram_bot_token || config.telegram_bot_token || ''
  const chatId = job.telegram_chat_id || config.telegram_chat_id || ''
  if (!botToken || !chatId) {
    console.error(`[${job.name}] telegram: missing bot_token or chat_id`)
    return Promise.resolve()
  }

  const message = `\u{1F4CB} ${job.name}\n\n${result}`
  return (async () => {
    try {
      const chunks: string[] = []
      for (let i = 0; i < message.length; i += TELEGRAM_MAX_LENGTH) {
        chunks.push(message.slice(i, i + TELEGRAM_MAX_LENGTH))
      }
      for (const chunk of chunks) {
        const ok = await sendTelegram(chunk, botToken, chatId)
        if (!ok) {
          console.error(
            `[${job.name}] telegram: chunk send failed (${chunk.length} chars)`,
          )
        }
      }
      console.log(
        `[${job.name}] telegram notification sent (${chunks.length} chunk(s))`,
      )
    } catch (e) {
      const err = e as Error
      console.error(
        `[${job.name}] telegram failed:`,
        err.message,
        err.cause ?? '',
      )
    }
  })()
}

function buildCommand(config: Config, job: Job): string {
  if (job.command) return job.command

  if (job.prompt) {
    const template = config.prompt_template
    if (!template) {
      throw new Error(
        `Job "${job.name}" uses prompt mode but config.prompt_template is not set`,
      )
    }
    const promptPath = resolvePromptPath(job.prompt)
    return template.replace('{prompt}', promptPath)
  }

  throw new Error(`Job "${job.name}" must have either "command" or "prompt"`)
}

interface RunningJob {
  child: ChildProcess
  promise: Promise<void>
  startedAt: Date
}

// 실행 중인 잡 추적 — 핫리로드 시 기다리기 위함
const runningJobs = new Map<string, RunningJob>()

function runJob(config: Config, job: Job): Promise<void> {
  const existing = runningJobs.get(job.name)
  if (existing) {
    console.warn(
      `[${job.name}] already running since ${existing.startedAt.toISOString()}, skipping duplicate execution`,
    )
    return existing.promise
  }

  let childRef: ChildProcess | null = null

  const promise = new Promise<void>((resolve) => {
    const startTime = new Date().toISOString()
    console.log(`[${startTime}] running: ${job.name}`)

    try {
      const command = buildCommand(config, job)
      const timeoutMs =
        job.timeout_ms ?? config.default_timeout_ms ?? FALLBACK_TIMEOUT_MS

      childRef = exec(
        command,
        {
          cwd: ROOT_DIR,
          timeout: timeoutMs,
          env: {
            ...process.env,
            PATH: `${process.env.HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ''}`,
          },
        },
        async (error, stdout, stderr) => {
          runningJobs.delete(job.name)
          const result = stdout.trim()

          if (error) {
            const killed = error.signal === 'SIGTERM' && error.code === null
            const reason = killed
              ? `timeout after ${Math.round(timeoutMs / 1000)}s (SIGTERM)`
              : `exit code ${error.code}`
            const errMsg = `${reason}: ${stderr.slice(0, 500)}`
            console.error(`[${job.name}] failed: ${errMsg}`)
            if (job.notify === 'telegram') {
              await notifyTelegram(config, job, `Job failed: ${errMsg}`)
            }
          } else if (result) {
            console.log(`[${job.name}] done (${result.length} chars)`)
            if (job.notify === 'telegram') {
              await notifyTelegram(config, job, result)
            }
          } else {
            console.log(`[${job.name}] done (no output, skipping notification)`)
          }
          resolve()
        },
      )
    } catch (e) {
      const errMsg = `Job failed: ${(e as Error).message}`
      console.error(`[${job.name}] ${errMsg}`)
      if (job.notify === 'telegram') {
        notifyTelegram(config, job, errMsg)
      }
      resolve()
    }
  })

  if (childRef) {
    runningJobs.set(job.name, {
      child: childRef,
      promise,
      startedAt: new Date(),
    })
  }

  return promise
}

// 등록된 크론 태스크 추적 (재로드 시 정리용)
const scheduledTasks: ReturnType<typeof cron.schedule>[] = []

function scheduleAll(): { config: Config; jobs: Job[] } {
  // 기존 크론 정리
  for (const task of scheduledTasks) {
    task.stop()
  }
  scheduledTasks.length = 0

  const loaded = loadConfig()
  const { config, jobs } = loaded

  if (jobs.length === 0) {
    console.log('No enabled jobs found.')
    return loaded
  }

  const timezone = config.timezone || 'UTC'

  console.log(`skillduler started with ${jobs.length} jobs:`)

  for (const job of jobs) {
    if (!cron.validate(job.cron)) {
      console.error(`  \u2717 ${job.name}: invalid cron "${job.cron}"`)
      continue
    }

    const task = cron.schedule(job.cron, () => runJob(config, job), {
      timezone,
      noOverlap: true,
    })
    scheduledTasks.push(task)
    console.log(`  \u2713 ${job.name}: ${job.cron} \u2014 ${job.description}`)
  }

  return loaded
}

function main(): void {
  const initial = scheduleAll()

  // jobs.yaml 변경 감시 — 핫 리로드
  // 실행 중인 잡이 있으면 완료 대기 후 리로드 (SIGTERM으로 죽이지 않음)
  let reloadTimer: ReturnType<typeof setTimeout> | null = null
  // 진행 중 리로드와 펜딩 리로드를 promise chain으로 직렬화
  let reloadChain: Promise<void> = Promise.resolve()

  const performReload = async (): Promise<void> => {
    if (runningJobs.size > 0) {
      const names = Array.from(runningJobs.keys())
      console.log(
        `\n[hot-reload] waiting for ${runningJobs.size} running job(s) to finish before reload: ${names.join(', ')}`,
      )
      await Promise.all(Array.from(runningJobs.values()).map((r) => r.promise))
    }
    console.log('[hot-reload] jobs.yaml changed, reloading...')
    const { config, jobs } = scheduleAll()
    const msg = `[hot-reload] jobs.yaml 리로드 완료: ${jobs.length}개 잡 로드됨`
    console.log(`${msg}\n`)
    const botToken = config.telegram_bot_token || ''
    const chatId = config.telegram_chat_id || ''
    if (botToken && chatId) {
      sendTelegram(msg, botToken, chatId).catch((e) => {
        console.error(
          `[hot-reload] telegram notification failed: ${(e as Error).message}`,
        )
      })
    }
  }

  watch(JOBS_FILE, () => {
    // 디바운스: 500ms 내 중복 이벤트 무시
    if (reloadTimer) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      reloadChain = reloadChain
        .then(() => performReload())
        .catch((e) => {
          console.error(`[hot-reload] failed: ${(e as Error).message}`)
        })
    }, 500)
  })

  const runNow = process.argv[2]
  if (runNow) {
    const { config, jobs } = initial
    const job = jobs.find((j) => j.name === runNow)
    if (job) {
      console.log(`\nRunning "${runNow}" immediately...`)
      runJob(config, job).then(() => {
        if (!process.argv.includes('--daemon')) process.exit(0)
      })
    } else {
      console.error(`Job not found: ${runNow}`)
      console.log(`Available: ${jobs.map((j) => j.name).join(', ')}`)
      process.exit(1)
    }
  }
}

main()
