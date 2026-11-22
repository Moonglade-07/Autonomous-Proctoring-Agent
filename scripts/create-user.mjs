/**
 * scripts/create-user.mjs — CLI tool to bootstrap initial admin or staff accounts
 * ─────────────────────────────────────────────────────────────────────────────
 * Usage:
 *   node scripts/create-user.mjs --role admin --email admin@example.com --name "System Admin" [--remote]
 *   npm run user:create -- --role admin --email admin@example.com --name "System Admin" [--remote]
 *
 * Password is read interactively from a hidden prompt (never via CLI flags or shell history).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import readline from 'node:readline';
import { Writable } from 'node:stream';

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    role: '',
    email: '',
    name: '',
    department: '',
    student_id: '',
    remote: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--role' && args[i + 1]) options.role = args[++i];
    else if (arg === '--email' && args[i + 1]) options.email = args[++i];
    else if (arg === '--name' && args[i + 1]) options.name = args[++i];
    else if (arg === '--department' && args[i + 1]) options.department = args[++i];
    else if (arg === '--student_id' && args[i + 1]) options.student_id = args[++i];
    else if (arg === '--remote') options.remote = true;
  }

  return options;
}

function promptHidden(query) {
  const mutableStdout = new Writable({
    write(chunk, encoding, callback) {
      if (!this.muted) {
        process.stdout.write(chunk, encoding);
      }
      callback();
    },
  });
  mutableStdout.muted = false;

  const rl = readline.createInterface({
    input: process.stdin,
    output: mutableStdout,
    terminal: true,
  });

  return new Promise((resolve) => {
    rl.question(query, (password) => {
      process.stdout.write('\n');
      rl.close();
      resolve(password);
    });
    mutableStdout.muted = true;
  });
}

async function main() {
  const opts = parseArgs();

  if (!opts.role || !['admin', 'professor', 'student'].includes(opts.role)) {
    console.error('Error: --role must be one of "admin", "professor", or "student"');
    process.exit(1);
  }

  if (!opts.email || !opts.email.includes('@')) {
    console.error('Error: valid --email is required');
    process.exit(1);
  }

  if (!opts.name || opts.name.trim().length === 0) {
    console.error('Error: --name is required');
    process.exit(1);
  }

  const email = opts.email.toLowerCase().trim();
  const name = opts.name.trim();

  // Hidden password prompt
  const password = await promptHidden(`Enter password for ${email} (10-128 chars): `);
  if (!password || password.length < 10 || password.length > 128) {
    console.error('Error: password must be between 10 and 128 characters long');
    process.exit(1);
  }

  const confirmPassword = await promptHidden('Confirm password: ');
  if (password !== confirmPassword) {
    console.error('Error: passwords do not match');
    process.exit(1);
  }

  // PBKDF2-SHA256 with 100,000 iterations, 16-byte random salt, 32-byte key
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, 100_000, 32, 'sha256');

  const saltHex = salt.toString('hex');
  const hashHex = hash.toString('hex');
  const userId = `usr-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const deptVal = opts.department ? `'${opts.department.replace(/'/g, "''")}'` : 'NULL';
  const studentIdVal = opts.student_id ? `'${opts.student_id.replace(/'/g, "''")}'` : 'NULL';

  const sql = `INSERT INTO users (id, email, name, role, password_hash, password_salt, student_id, department, active, token_version, created_at, last_login_at) VALUES ('${userId}', '${email.replace(/'/g, "''")}', '${name.replace(/'/g, "''")}', '${opts.role}', '${hashHex}', '${saltHex}', ${studentIdVal}, ${deptVal}, 1, 0, '${now}', NULL);`;

  console.log(`\nInserting user ${email} (${opts.role}) into D1 (${opts.remote ? 'REMOTE' : 'LOCAL'})...`);

  const remoteFlag = opts.remote ? '--remote' : '--local';
  try {
    execSync(`npx wrangler d1 execute apa-db ${remoteFlag} --command="${sql}"`, {
      stdio: 'inherit',
    });
    console.log(`\n✓ User created successfully!\n  ID: ${userId}\n  Email: ${email}\n  Role: ${opts.role}\n`);
  } catch (err) {
    console.error('\n❌ Failed to insert user into D1:', err.message);
    process.exit(1);
  }
}

main();
