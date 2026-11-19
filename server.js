require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const { Pool } = require("pg");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: false
}));

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === "true"
        ? { rejectUnauthorized: false }
        : undefined
    })
  : null;

// الصفحة الرئيسية
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// فحص حالة الموقع وقاعدة البيانات
app.get("/api/health", async (req, res) => {
  let database = "not_configured";

  if (pool) {
    try {
      await pool.query("SELECT 1");
      database = "connected";
    } catch (error) {
      database = "disconnected";
    }
  }

  res.json({
    application: "FEDERAL BUREAU",
    status: "running",
    database
  });
});

// تقديم ملفات الموقع
app.use(express.static(path.join(__dirname, "public")));

// معالجة الصفحات غير الموجودة
app.use((req, res) => {
  res.status(404).json({
    error: "Page not found"
  });
});

// معالجة الأخطاء
app.use((error, req, res, next) => {
  console.error("Server error:", error.message);
  res.status(500).json({
    error: "Internal server error"
  });
});

const server = app.listen(PORT, () => {
  console.log(`FEDERAL BUREAU running on port ${PORT}`);
});

process.on("SIGTERM", async () => {
  server.close(async () => {
    if (pool) await pool.end();
    process.exit(0);
  });
});
