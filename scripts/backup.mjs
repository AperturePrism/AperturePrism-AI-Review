#!/usr/bin/env node
/**
 * Dumps the AperturePrism PostgreSQL database to a timestamped file.
 * Uses the container name from the production compose (or PG_HOST/DATABASE_URL).
 *
 *   node scripts/backup.mjs                    # via docker compose exec
 *   PG_HOST=... PG_PORT=5432 PG_USER=... node scripts/backup.mjs
 *
 * Output lands in ./backups/<iso>.sql.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { config as loadDotenv } from "dotenv";

loadDotenv();

const iso = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = new URL("../backups/", import.meta.url);
mkdirSync(outDir, { recursive: true });
const outFile = new URL(`${iso}.sql`, outDir);

const useCompose = !process.env.PG_HOST;
const args = useCompose
  ? [
      "compose",
      "-f",
      "docker/docker-compose.prod.yml",
      "exec",
      "-T",
      "postgres",
      "pg_dump",
      "-U",
      process.env.POSTGRES_USER ?? "apertureprism",
      "-d",
      process.env.POSTGRES_DB ?? "apertureprism",
    ]
  : [
      "pg_dump",
      "-h",
      process.env.PG_HOST,
      "-p",
      process.env.PG_PORT ?? "5432",
      "-U",
      process.env.PG_USER ?? "apertureprism",
      "-d",
      process.env.PG_DB ?? "apertureprism",
    ];

console.log(`backup: dumping to ${outFile.pathname}`);
// compose 模式经 `docker compose exec postgres pg_dump` 导出；直连模式（设置了
// PG_HOST）则直接调用本机 `pg_dump`。此前两者都 spawn `docker`，导致直连模式
// 变成 `docker pg_dump …`（"docker: 'pg_dump' is not a docker command"）。
const child = spawn(useCompose ? "docker" : "pg_dump", args, {
  env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD ?? process.env.POSTGRES_PASSWORD ?? "" },
});
const chunks = [];
child.stdout.on("data", (chunk) => chunks.push(chunk));
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
child.on("error", (error) => {
  console.error(`backup: failed to spawn: ${error.message}`);
  process.exit(1);
});
child.on("close", (code) => {
  if (code !== 0) {
    console.error(`backup: pg_dump exited with code ${code}`);
    process.exit(code ?? 1);
  }
  writeFileSync(outFile, Buffer.concat(chunks));
  console.log(`backup: done (${outFile.pathname}, ${Buffer.concat(chunks).length} bytes)`);
});
