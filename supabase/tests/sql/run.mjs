// Testes do SQL (Postgres real, sem Supabase). Rodar: cd supabase/tests/sql && npm i && node run.mjs ../../migrations inteligencia.mjs
// Sobe um Postgres local, cria o banco do zero com stubs do Supabase + todas as migrations e roda os testes SQL.
// node run.mjs <pasta das migrations> [arquivo de teste .mjs]
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'))
const migDir = process.argv[2]
const testFile = process.argv[3]
const dataDir = path.join(here, 'data')
const fresh = !fs.existsSync(path.join(dataDir, 'PG_VERSION'))
const db = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port: 54329, persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C'] })
if (fresh) await db.initialise()
await db.start()
try {
  const admin = new pg.Client({ host: 'localhost', port: 54329, user: 'postgres', password: 'postgres', database: 'postgres' })
  await admin.connect()
  await admin.query('drop database if exists teste with (force)')
  await admin.query('create database teste')
  await admin.end()
  const conn = () => new pg.Client({ host: 'localhost', port: 54329, user: 'postgres', password: 'postgres', database: 'teste' })
  const c = conn()
  c.on('error', () => {})
  await c.connect()
  await c.query(fs.readFileSync(path.join(here, 'stubs.sql'), 'utf8'))
  const files = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()
  for (const f of files) {
    try {
      // pg_cron e pg_net não existem aqui: os esquemas cron e net são stubs
      await c.query(fs.readFileSync(path.join(migDir, f), 'utf8').replace(/create extension if not exists (pg_cron|pg_net)[^;]*;/gi, ''))
    } catch (e) {
      console.error(`ERRO em ${f}: ${e.message}${e.position ? ` (posição ${e.position})` : ''}${e.where ? `\n${e.where}` : ''}`)
      if (e.position) {
        const sql = fs.readFileSync(path.join(migDir, f), 'utf8')
        const p = +e.position
        console.error('...' + sql.slice(Math.max(0, p - 300), p) + ' <<<AQUI>>> ' + sql.slice(p, p + 200))
      }
      process.exitCode = 1
      throw e
    }
  }
  console.log(`migrations aplicadas: ${files.length}`)
  await c.end()
  if (testFile) {
    const mod = await import(pathToFileURL(path.resolve(testFile)).href)
    await mod.default({ conn })
  }
} finally {
  await db.stop()
}
