import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'options', 'head'])

function maskNonCode(source) {
  const output = source.split('')
  let state = 'code'
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (state === 'code') {
      if (char === '/' && next === '/') {
        output[index] = output[index + 1] = ' '
        index += 1
        state = 'line'
      } else if (char === '/' && next === '*') {
        output[index] = output[index + 1] = ' '
        index += 1
        state = 'block'
      } else if (char === "'" || char === '"' || char === '`') {
        output[index] = ' '
        state = char
      }
    } else if (state === 'line') {
      if (char === '\n') state = 'code'
      else output[index] = ' '
    } else if (state === 'block') {
      if (char === '*' && next === '/') {
        output[index] = output[index + 1] = ' '
        index += 1
        state = 'code'
      } else if (char !== '\n') output[index] = ' '
    } else if (char === '\\') {
      output[index] = ' '
      if (index + 1 < source.length) output[++index] = ' '
    } else if (char === state) {
      output[index] = ' '
      state = 'code'
    } else if (char !== '\n') output[index] = ' '
  }
  return output.join('')
}

function callArguments(source, masked, opening) {
  const stack = []
  const items = []
  let start = opening + 1
  for (let index = opening; index < masked.length; index += 1) {
    const char = masked[index]
    if ('([{'.includes(char)) stack.push(char)
    else if (')]}'.includes(char)) {
      if (!stack.length) return null
      const previous = stack.pop()
      if ('([{'.indexOf(previous) !== ')]}'.indexOf(char)) return null
      if (!stack.length) {
        items.push(source.slice(start, index).trim())
        return { items, end: index }
      }
    } else if (char === ',' && stack.length === 1) {
      items.push(source.slice(start, index).trim())
      start = index + 1
    }
  }
  return null
}

function locateLine(source, offset) {
  let line = 1
  for (let index = 0; index < offset; index += 1) if (source[index] === '\n') line += 1
  return line
}

export function inspectSource(source, changedLines, filename) {
  const masked = maskNonCode(source)
  const limiterNames = new Map()
  const definition = /\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:await\s+)?(?:rateLimit|createRateLimiter|createIpLimiter|ipRateLimit)\s*\(/g
  for (const match of masked.matchAll(definition)) {
    const opening = masked.indexOf('(', match.index + match[0].length - 1)
    const call = callArguments(source, masked, opening)
    if (call) limiterNames.set(match[1], source.slice(opening, call.end + 1))
  }
  const issues = []
  const warnings = []
  const declaration = /\b(?:router|app|[\w$]+Router)\s*\.\s*(get|post|put|patch|delete|all|options|head)\s*\(/g
  for (const match of masked.matchAll(declaration)) {
    if (!methods.has(match[1])) continue
    const line = locateLine(masked, match.index)
    if (!changedLines.has(line)) continue
    const opening = masked.indexOf('(', match.index + match[0].length - 1)
    const call = callArguments(source, masked, opening)
    const name = `${filename}:${line} ${match[1].toUpperCase()}`
    if (!call || call.items.length < 2) {
      issues.push(`${name}: Cannot verify route middleware; review required`)
      continue
    }
    const path = call.items[0]
    if (/webhook|callback|health|cron|internal/i.test(`${filename} ${path}`)) {
      warnings.push(`${name} ${path}: Special endpoint; manually verify abuse protection, signatures and retry behavior`)
      continue
    }
    const first = call.items[1]
    const identifier = /^[\w$]+$/.test(first) ? first : null
    const inline = /^rateLimit\s*\(/.test(first)
    const limiter = identifier ? limiterNames.get(identifier) : null
    if (!inline && !limiter) {
      issues.push(`${name} ${path}: First middleware must be a verifiable pre-auth IP rate limiter`)
      continue
    }
    if (limiter && /keyGenerator\s*:/.test(limiter) && /req\s*\.\s*(user|admin)/.test(limiter)) {
      issues.push(`${name} ${path}: First limiter uses authenticated identity before auth`)
      continue
    }
    if (/\brequire(?:User|Admin|AdminPermission|Auth)\b/.test(call.items.slice(2).join(' '))) {
      const namedCount = call.items.slice(1).filter(item => limiterNames.has(item)).length
      if (namedCount < 2) warnings.push(`${name} ${path}: Review post-auth user/admin and write-specific limits`)
    }
  }
  const chained = /\b(?:router|app|[\w$]+Router)\s*\.\s*route\s*\(/g
  for (const match of masked.matchAll(chained)) {
    const line = locateLine(masked, match.index)
    if (changedLines.has(line)) issues.push(`${filename}:${line}: Chained route requires explicit manual rate-limit review`)
  }
  return { issues, warnings }
}

function addedLines(patch) {
  const changed = new Map()
  let filename = null
  let lineNumber = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ b/')) {
      filename = line.slice(6)
      if (!changed.has(filename)) changed.set(filename, new Set())
    } else if (line.startsWith('@@ ')) {
      const match = line.match(/\+(\d+)(?:,\d+)?\s+@@/)
      if (match) lineNumber = Number(match[1])
    } else if (filename && line.startsWith('+') && !line.startsWith('+++')) {
      changed.get(filename).add(lineNumber++)
    } else if (filename && line.startsWith(' ')) lineNumber += 1
  }
  return changed
}

function option(name, fallback) {
  const position = process.argv.indexOf(name)
  if (position < 0) return fallback
  if (!process.argv[position + 1]) throw new Error(`Missing value for ${name}`)
  return process.argv[position + 1]
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trimEnd()
}

function main() {
  const base = option('--base', process.env.ROUTE_CHECK_BASE || 'HEAD~1')
  const head = option('--head', process.env.ROUTE_CHECK_HEAD || 'HEAD')
  git('rev-parse', '--verify', `${base}^{commit}`)
  git('rev-parse', '--verify', `${head}^{commit}`)
  const patch = git('diff', '--no-ext-diff', '--unified=0', '--diff-filter=ACMR', `${base}...${head}`, '--', 'src/routes', 'server.js')
  const files = addedLines(patch)
  const issues = []
  const warnings = []
  let examined = 0
  for (const [filename, lines] of files) {
    if (!/^(?:src\/routes\/.*\.[cm]?js|server\.js)$/.test(filename)) continue
    const absolute = resolve(process.cwd(), filename)
    if (!existsSync(absolute)) continue
    const result = inspectSource(readFileSync(absolute, 'utf8'), lines, filename)
    examined += 1
    issues.push(...result.issues)
    warnings.push(...result.warnings)
  }
  for (const message of warnings) process.stdout.write(`REVIEW ${message}\n`)
  for (const message of issues) process.stderr.write(`FAIL ${message}\n`)
  process.stdout.write(`Route rate-limit check: ${examined} changed file(s), ${issues.length} failure(s), ${warnings.length} manual review(s)\n`)
  if (issues.length) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`Route rate-limit check could not run: ${error.message}\n`)
    process.exitCode = 1
  }
}
