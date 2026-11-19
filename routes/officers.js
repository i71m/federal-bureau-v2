
const express = require("express");
const bcrypt = require("bcrypt");

module.exports = function (pool) {
  const router = express.Router();

  function requireAdmin(req, res, next) {
    const officer = req.session.officer;

    if (!officer) {
      return res.status(401).json({
        error: "يجب تسجيل الدخول أولاً"
      });
    }

    const role = String(officer.role || "").toLowerCase();
    const rank = String(officer.rank || "").toLowerCase();

    if (
      role !== "admin" &&
      role !== "director" &&
      rank !== "director"
    ) {
      return res.status(403).json({
        error: "ليست لديك صلاحية إدارة الضباط"
      });
    }

    next();
  }

  router.get("/", requireAdmin, async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT id, username, full_name, rank, role, active, created_at
         FROM officers
         ORDER BY created_at DESC`
      );

      res.json({
        success: true,
        officers: result.rows
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", requireAdmin, async (req, res, next) => {
    try {
      const { username, password, full_name, rank } = req.body;

      if (!username || !password || !full_name || !rank) {
        return res.status(400).json({
          error: "يرجى تعبئة جميع البيانات"
        });
      }

      if (password.length < 8) {
        return res.status(400).json({
          error: "كلمة المرور يجب أن تكون 8 أحرف على الأقل"
        });
      }

      const passwordHash = await bcrypt.hash(password, 12);

      const result = await pool.query(
        `INSERT INTO officers
          (username, password_hash, full_name, rank, role, active)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         RETURNING id, username, full_name, rank, role, active`,
        [
          username.trim(),
          passwordHash,
          full_name.trim(),
          rank.trim(),
          "officer"
        ]
      );

      res.status(201).json({
        success: true,
        message: "تم إنشاء حساب الضابط بنجاح",
        officer: result.rows[0]
      });

    } catch (error) {
      if (error.code === "23505") {
        return res.status(409).json({
          error: "اسم المستخدم مستخدم بالفعل"
        });
      }

      next(error);
    }
  });

  return router;
};
