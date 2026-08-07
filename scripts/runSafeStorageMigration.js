import dotenv from 'dotenv'
import { spawn } from 'node:child_process'
import { supabase } from '../src/config/supabase.js'

dotenv.config()

const APPLY_CONFIRM_VALUE =
  'MIGRATE_ALL_SUPABASE_MEDIA_TO_R2'

function clean(value) {
  return String(value ?? '').trim()
}

function isApplyMode() {
  return clean(
    process.env.MIGRATION_MODE || 'dry-run'
  ).toLowerCase() === 'apply'
}

function runNodeScript(scriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [scriptPath],
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
            `${scriptPath} stopped by ${signal}`
          )
        )
        return
      }

      resolve(Number(code || 0))
    })
  })
}

async function findPrivateBucketsWithObjects() {
  const { data: buckets, error } =
    await supabase.storage.listBuckets()

  if (error) throw error

  const blocked = []

  for (const bucket of buckets || []) {
    if (bucket.public) continue

    const { data, error: listError } =
      await supabase.storage
        .from(bucket.id)
        .list('', {
          limit: 1,
          offset: 0,
        })

    if (listError) throw listError

    if ((data || []).length) {
      blocked.push(bucket.id)
    }
  }

  return blocked
}

async function holdCleanupSchedules() {
  const { error } = await supabase
    .from('storage_migrations')
    .update({
      delete_after: null,
      status: 'verified',
      last_cleanup_error:
        'Cleanup held until 30-day release verification.',
      updated_at: new Date().toISOString(),
    })
    .eq(
      'source_kind',
      'supabase_storage'
    )
    .is('deleted_at', null)
    .not('verified_at', 'is', null)

  if (error) throw error
}

async function main() {
  if (
    isApplyMode() &&
    clean(process.env.MIGRATION_CONFIRM) !==
      APPLY_CONFIRM_VALUE
  ) {
    throw new Error(
      `Apply mode requires MIGRATION_CONFIRM=${APPLY_CONFIRM_VALUE}`
    )
  }

  const privateBuckets =
    await findPrivateBucketsWithObjects()

  if (privateBuckets.length) {
    console.log(
      JSON.stringify(
        {
          private_buckets_with_objects:
            privateBuckets,
          public_migration_allowed:
            !isApplyMode(),
          note:
            isApplyMode()
              ? 'APPLY blocked. Private Supabase Storage must never be copied to public R2.'
              : 'Dry-run may continue, but APPLY will be blocked until private storage is handled safely.',
        },
        null,
        2
      )
    )

    if (isApplyMode()) {
      process.exitCode = 1
      return
    }
  }

  const originalCode =
    await runNodeScript(
      'scripts/migrateActiveSupabaseMediaToR2.js'
    )

  if (isApplyMode()) {
    await holdCleanupSchedules()
  }

  if (originalCode !== 0) {
    process.exitCode = originalCode
    return
  }

  const additionalCode =
    await runNodeScript(
      'scripts/migrateAdditionalActiveMediaToR2.js'
    )

  if (isApplyMode()) {
    await holdCleanupSchedules()
  }

  if (additionalCode !== 0) {
    process.exitCode = additionalCode
    return
  }

  if (!isApplyMode()) {
    return
  }

  const verifyCode =
    await runNodeScript(
      'scripts/verifyStorageMigration.js'
    )

  await holdCleanupSchedules()

  if (verifyCode !== 0) {
    process.exitCode = verifyCode
    return
  }

  console.log(
    JSON.stringify(
      {
        migration_verified: true,
        source_deletion: 'HELD',
        retention:
          'Supabase source remains retained. Use releaseStorageCleanupAfterVerification.js only after 30 days.',
      },
      null,
      2
    )
  )
}

main().catch((error) => {
  console.error(
    'SAFE STORAGE MIGRATION FAILED'
  )
  console.error(error)
  process.exit(1)
})
