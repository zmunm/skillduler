#!/usr/bin/env node

import { exec } from 'node:child_process'
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
  enabled: boolean
}

interface Config {
  prompt_template?: string
  timezone?: string
  telegram_bot_token?: string
  telegram_chat_id?: string
}

interface JobsConfig {
  config?: Config
  jobs: Job[]
}

const ROOT_DIR = path.resolve(import.meta.dirname, '..')
const JOBS_FILE = path.join(ROOT_DIR, 'jobs.yaml')

function loadConfig(): { config: Config; jobs: Job[] } {
  const raw = readFileSync(JOBS_FILE, 'utf-8')
  const parsed = parseYaml(raw) as JobsConfig
  return {
    config: parsed.config || {},
    jobs: parsed.jobs.filter((j) => j.enabled),
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
      if (message.length <= TELEGRAM_MAX_LENGTH) {
        await sendTelegram(message, botToken, chatId)
      } else {
        await sendTelegram(
          message.slice(0, TELEGRAM_MAX_LENGTH),
          botToken,
          chatId,
        )
        await sendTelegram(message.slice(TELEGRAM_MAX_LENGTH), botToken, chatId)
      }
      console.log(`[${job.name}] telegram notification sent`)
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

function runJob(config: Config, job: Job): Promise<void> {
  return new Promise((resolve) => {
    const startTime = new Date().toISOString()
    console.log(`[${startTime}] running: ${job.name}`)

    try {
      const command = buildCommand(config, job)

      exec(
        command,
        {
          cwd: ROOT_DIR,
          timeout: 300000,
          env: {
            ...process.env,
            PATH: `${process.env.HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ''}`,
          },
        },
        async (error, stdout, stderr) => {
          const result = stdout.trim()

          if (!error && result) {
            console.log(`[${job.name}] done (${result.length} chars)`)
            if (job.notify === 'telegram') {
              await notifyTelegram(config, job, result)
            }
          } else {
            const errMsg = error
              ? `exit code ${error.code}: ${stderr.slice(0, 200)}`
              : 'no output'
            console.error(`[${job.name}] failed: ${errMsg}`)
            if (job.notify === 'telegram') {
              await notifyTelegram(config, job, `Job failed: ${errMsg}`)
            }
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
}

// 등록된 크론 태스크 추적 (재로드 시 정리용)
const scheduledTasks: ReturnType<typeof cron.schedule>[] = []

function scheduleAll(): void {
  // 기존 크론 정리
  for (const task of scheduledTasks) {
    task.stop()
  }
  scheduledTasks.length = 0

  const { config, jobs } = loadConfig()

  if (jobs.length === 0) {
    console.log('No enabled jobs found.')
    return
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
    })
    scheduledTasks.push(task)
    console.log(`  \u2713 ${job.name}: ${job.cron} \u2014 ${job.description}`)
  }
}

function main(): void {
  scheduleAll()

  // jobs.yaml 변경 감시 — 핫 리로드
  let reloadTimer: ReturnType<typeof setTimeout> | null = null
  watch(JOBS_FILE, () => {
    // 디바운스: 500ms 내 중복 이벤트 무시
    if (reloadTimer) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      console.log('\n[hot-reload] jobs.yaml changed, reloading...')
      try {
        scheduleAll()
        console.log('[hot-reload] done\n')
      } catch (e) {
        console.error(`[hot-reload] failed: ${(e as Error).message}`)
      }
    }, 500)
  })

  const runNow = process.argv[2]
  if (runNow) {
    const { config, jobs } = loadConfig()
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
