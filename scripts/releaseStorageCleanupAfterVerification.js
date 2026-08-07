import dotenv from 'dotenv'
import { spawn } from 'node:child_process'
import { supabase } from '../src/config/supabase.js'

dotenv.config()

const MIN_RETENTION_DAYS = 30
const RELEASE_CONFIRM_VALUE =
  'RELEASE_VERIFIED_SUPABASE_SOURCE_CLEANUP'
const PAGE_SIZE = 1000

function clean(value) {
  return String(value ?? '').trim()
}

function runVerifier() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['scripts/verifyStorageMigration.js'],
      {
        stdio: 'inherit',
        env: process.env,
      }
    )

    child.on('error', reject)

    child.on('exit', (code, signal) => {
      if (signal) {
        reject(
          new Error(
            `Verifier stopped by ${signal}`
          )
        )
        return
      }

      resolve(Number(code || 0))
    })
  })
}

async function readEligibleRows() {
  const rows = []
  let from = 0

  while (true) {
    const { data, error } = await supabase
      .from('storage_migrations')
      .select(
        'migration_key, verified_at, deleted_at, source_kind'
      )
      .eq(
        'source_kind',
        'supabase_storage'
      )
      .is('deleted_at', null)
      .not('verified_at', 'is', null)
      .range(
        from,
        from + PAGE_SIZE - 1
      )

    if (error) throw error

    const page = data || []
    rows.push(...page)

    if (page.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  const cutoff =
    Date.now() -
    MIN_RETENTION_DAYS *
      24 * 60 * 60 * 1000

  return rows.filter((row) => {
    const verifiedAt =
      new Date(row.verified_at).getTime()

    return (
      Number.isFinite(verifiedAt) &&
      verifiedAt <= cutoff
    )
  })
}

async function releaseRows(rows) {
  if (!rows.length) return 0

  const now = new Date().toISOString()
  let released = 0

  for (
    let index = 0;
    index < rows.length;
    index += 200
  ) {
    const keys = rows
      .slice(index, index + 200)
      .map((row) => row.migration_key)

    const { error } = await supabase
      .from('storage_migrations')
      .update({
        delete_after: now,
        status: 'delete_pending',
        last_cleanup_error: null,
        updated_at: now,
      })
      .in('migration_key', keys)

    if (error) throw error
    released += keys.length
  }

  return released
}

async function main() {
  if (
    clean(
      process.env
        .RELEASE_STORAGE_CLEANUP_CONFIRM
    ) !== RELEASE_CONFIRM_VALUE
  ) {
    throw new Error(
      `Release requires RELEASE_STORAGE_CLEANUP_CONFIRM=${RELEASE_CONFIRM_VALUE}`
    )
  }

  const eligible =
    await readEligibleRows()

  if (!eligible.length) {
    console.log(
      JSON.stringify(
        {
          eligible: 0,
          released: 0,
          message:
            'No verified Supabase source has reached the 30-day minimum retention period.',
        },
        null,
        2
      )
    )
    return
  }

  const verifyCode =
    await runVerifier()

  if (verifyCode !== 0) {
    console.error(
      'Cleanup release blocked because final storage verification failed.'
    )
    process.exitCode = 1
    return
  }

  const released =
    await releaseRows(eligible)

  console.log(
    JSON.stringify(
      {
        eligible: eligible.length,
        released,
        verification: 'PASS',
        next:
          'The existing cleanup scheduler may now delete only released rows after its own R2 and active-reference checks.',
      },
      null,
      2
    )
  )
}

main().catch((error) => {
  console.error(
    'STORAGE CLEANUP RELEASE FAILED'
  )
  console.error(error)
  process.exit(1)
})
