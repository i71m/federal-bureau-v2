
const express = require("express");
const bcrypt = require("bcrypt");

module.exports = function (pool) {
  const router = express.Router();

  // التحقق من صلاحية المدير
  function requireAdmin(req, res, next) {
    if (!req.session || !req.session.officer) {
      return res.status(401).json({
        success: false,
        error: "يجب تسجيل الدخول أولاً"
      });
    }

    if (
      String(req.session.officer.role || "").toLowerCase() !== "admin"
    ) {
      return res.status(403).json({
        success: false,
        error: "ليست لديك صلاحية إدارة الضباط"
      });
    }

    next();
  }

  // التحقق من رقم الحساب
  function validId(id) {
    return /^[1-9]\d*$/.test(String(id));
  }

  // التحقق من بيانات إنشاء الحساب
  function validateOfficer(body) {
    const { username, password, full_name, rank } = body || {};

    if (
      typeof username !== "string" ||
      !username.trim() ||
      typeof password !== "string" ||
      !password ||
      typeof full_name !== "string" ||
      !full_name.trim() ||
      typeof rank !== "string" ||
      !rank.trim()
    ) {
      return "يرجى تعبئة جميع البيانات بشكل صحيح";
    }

    if (username.trim().length < 3 || username.trim().length > 50) {
      return "اسم المستخدم يجب أن يكون بين 3 و50 حرفاً";
    }

    if (!/^[a-zA-Z0-9_.-]+$/.test(username.trim())) {
      return "اسم المستخدم يجب أن يحتوي على أحرف إنجليزية أو أرقام أو الرموز . _ - فقط";
    }

    if (password.length < 8 || password.length > 1024) {
      return "كلمة المرور يجب أن تكون بين 8 و1024 حرفاً";
    }

    if (full_name.trim().length > 150) {
      return "الاسم الكامل يجب ألا يتجاوز 150 حرفاً";
    }

    const validRanks = Array.from(
      { length: 11 },
      (_, i) => `Agent ${i}`
    );

    if (!validRanks.includes(rank)) {
      return "الرتبة غير صحيحة";
    }

    return null;
  }

  // تسجيل العملية في سجل العمليات
  async function writeAudit(client, officerId, action, details) {
    await client.query(
      `INSERT INTO audit_logs
       (officer_id, action, details)
       VALUES ($1, $2, $3)`,
      [
        officerId,
        action,
        typeof details === "string"
          ? details
          : JSON.stringify(details)
      ]
    );
  }

  // معالجة التراجع عن المعاملة بأمان
  async function rollback(client) {
    try {
      await client.query("ROLLBACK");
    } catch (error) {
      console.error("Officers ROLLBACK error:", error.message);
    }
  }

  // عرض جميع الضباط
  router.get("/", requireAdmin, async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT
           id,
           username,
           full_name,
           rank,
           role,
           active,
           created_at
         FROM officers
         ORDER BY created_at DESC`
      );

      return res.json({
        success: true,
        officers: result.rows
      });

    } catch (error) {
      console.error("Officers GET error:", error);
      next(error);
    }
  });

  // إنشاء حساب ضابط جديد
  router.post("/", requireAdmin, async (req, res, next) => {
    const validationError = validateOfficer(req.body);

    if (validationError) {
      return res.status(400).json({
        success: false,
        error: validationError
      });
    }

    let client;

    try {
      const username = req.body.username.trim();
      const fullName = req.body.full_name.trim();
      const passwordHash = await bcrypt.hash(req.body.password, 12);

      client = await pool.connect();

      await client.query("BEGIN");

      const result = await client.query(
        `INSERT INTO officers
         (
           username,
           password_hash,
           full_name,
           rank,
           role,
           active
         )
         VALUES ($1, $2, $3, $4, 'officer', TRUE)
         RETURNING id, username, full_name, rank, role, active, created_at`,
        [
          username,
          passwordHash,
          fullName,
          req.body.rank
        ]
      );

      const officer = result.rows[0];

      await writeAudit(
        client,
        req.session.officer.id,
        "CREATE_OFFICER",
        {
          message: "تم إنشاء حساب ضابط جديد",
          officer_id: officer.id,
          username: officer.username,
          full_name: officer.full_name,
          rank: officer.rank
        }
      );

      await client.query("COMMIT");

      return res.status(201).json({
        success: true,
        message: "تم إنشاء حساب الضابط بنجاح",
        officer
      });

    } catch (error) {
      if (client) await rollback(client);

      console.error("Officers POST error:", error);

      if (error.code === "23505") {
        return res.status(409).json({
          success: false,
          error: "اسم المستخدم مستخدم بالفعل"
        });
      }

      return next(error);

    } finally {
      if (client) client.release();
    }
  });

  // تفعيل أو تعطيل حساب ضابط
  router.patch("/:id/status", requireAdmin, async (req, res, next) => {
    const { id } = req.params;

    if (!validId(id)) {
      return res.status(400).json({
        success: false,
        error: "رقم حساب الضابط غير صالح"
      });
    }

    const { active } = req.body || {};

    if (typeof active !== "boolean") {
      return res.status(400).json({
        success: false,
        error: "حالة الحساب غير صحيحة"
      });
    }

    let client;

    try {
      client = await pool.connect();

      await client.query("BEGIN");

      const current = await client.query(
        `SELECT id, username, full_name, active
         FROM officers
         WHERE id = $1
           AND role <> 'admin'
         FOR UPDATE`,
        [id]
      );

      if (!current.rows.length) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          success: false,
          error: "الضابط غير موجود أو لا يمكن تعديل حسابه"
        });
      }

      const previous = current.rows[0];

      const result = await client.query(
        `UPDATE officers
         SET active = $1
         WHERE id = $2
         RETURNING id, username, full_name, rank, role, active`,
        [active, id]
      );

      if (previous.active !== active) {
        await writeAudit(
          client,
          req.session.officer.id,
          active ? "ACTIVATE_OFFICER" : "DISABLE_OFFICER",
          {
            message: active
              ? "تم تفعيل حساب ضابط"
              : "تم تعطيل حساب ضابط",
            officer_id: previous.id,
            username: previous.username,
            full_name: previous.full_name,
            active
          }
        );
      }

      await client.query("COMMIT");

      return res.json({
        success: true,
        message: active
          ? "تم تفعيل حساب الضابط"
          : "تم تعطيل حساب الضابط",
        officer: result.rows[0]
      });

    } catch (error) {
      if (client) await rollback(client);

      console.error("Officers STATUS error:", error);
      return next(error);

    } finally {
      if (client) client.release();
    }
  });

  // حذف حساب ضابط نهائياً
  router.delete("/:id", requireAdmin, async (req, res, next) => {
    const { id } = req.params;

    if (!validId(id)) {
      return res.status(400).json({
        success: false,
        error: "رقم حساب الضابط غير صالح"
      });
    }

    let client;

    try {
      client = await pool.connect();

      await client.query("BEGIN");

      const result = await client.query(
        `DELETE FROM officers
         WHERE id = $1
           AND role <> 'admin'
         RETURNING id, username, full_name, rank`,
        [id]
      );

      if (!result.rows.length) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          success: false,
          error: "الضابط غير موجود أو لا يمكن حذف حسابه"
        });
      }

      const officer = result.rows[0];

      await writeAudit(
        client,
        req.session.officer.id,
        "DELETE_OFFICER",
        {
          message: "تم حذف حساب ضابط نهائياً",
          officer_id: officer.id,
          username: officer.username,
          full_name: officer.full_name,
          rank: officer.rank
        }
      );

      await client.query("COMMIT");

      return res.json({
        success: true,
        message: "تم حذف حساب الضابط",
        officer
      });

    } catch (error) {
      if (client) await rollback(client);

      console.error("Officers DELETE error:", error);

      if (error.code === "23503") {
        return res.status(409).json({
          success: false,
          error: "هذا الضابط مرتبط بسجلات أخرى. عطّل حسابه بدلاً من حذفه."
        });
      }

      return next(error);

    } finally {
      if (client) client.release();
    }
  });

  return router;
};
