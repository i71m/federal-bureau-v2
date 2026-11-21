
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true"
    ? { rejectUnauthorized: false }
    : undefined
});

async function setup() {
  try {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is missing");
    }

    console.log("Setting up FEDERAL BUREAU database...");

    const sql = fs.readFileSync(
      path.join(__dirname, "database.sql"),
      "utf8"
    );

    await pool.query(sql);

    console.log("Database tables created successfully.");

    // التأكد من وجود جدول سجل تاريخ المطلوبين
    await pool.query(`
      SELECT id
      FROM wanted_history
      LIMIT 1
    `);

    console.log("Wanted history table verified successfully.");
    // إنشاء نظام أرشفة القضايا وطلبات الحذف دون فقدان السجلات
    await pool.query(`
      ALTER TABLE cases
      ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

      ALTER TABLE cases
      ADD COLUMN IF NOT EXISTS archived_by BIGINT
      REFERENCES officers(id) ON DELETE SET NULL;

      ALTER TABLE cases
      ADD COLUMN IF NOT EXISTS archive_reason TEXT;

      CREATE TABLE IF NOT EXISTS case_deletion_requests (
        id BIGSERIAL PRIMARY KEY,
        case_id BIGINT NOT NULL
          REFERENCES cases(id) ON DELETE RESTRICT,
        requested_by BIGINT
          REFERENCES officers(id) ON DELETE SET NULL,
        reason TEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'approved', 'rejected')),
        reviewed_by BIGINT
          REFERENCES officers(id) ON DELETE SET NULL,
        reviewed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS
        unique_pending_case_deletion
      ON case_deletion_requests(case_id)
      WHERE status = 'pending';

      CREATE INDEX IF NOT EXISTS
        idx_case_deletion_requests_status
      ON case_deletion_requests(status);
    `);

    console.log("Case archive and deletion requests tables verified successfully.");
    const username = process.env.BOOTSTRAP_ADMIN_USERNAME;
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    const fullName = process.env.BOOTSTRAP_ADMIN_NAME;

    if (!username && !password && !fullName) {
      console.log("Admin account setup skipped.");
      return;
    }

    if (!username || !password || !fullName) {
      throw new Error(
        "All three BOOTSTRAP_ADMIN variables are required."
      );
    }

    const existing = await pool.query(
      "SELECT id FROM officers WHERE LOWER(username) = LOWER($1)",
      [username]
    );

    if (existing.rows.length > 0) {
      console.log(
        "Admin username already exists. Existing account was not changed."
      );
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);

    await pool.query(
      `INSERT INTO officers
       (username, password_hash, full_name, rank, role, active)
       VALUES ($1, $2, $3, $4, $5, TRUE)`,
      [username, passwordHash, fullName, "Director", "admin"]
    );

    console.log("First administrator account created successfully.");

  } catch (error) {
    console.error("Setup failed:", error);
    process.exitCode = 1;

  } finally {
    await pool.end();
  }
}

setup();
