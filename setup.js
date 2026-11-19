
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
