
const express = require("express");
const bcrypt = require("bcrypt");

module.exports = function (pool) {
  const router = express.Router();

  function requireAdmin(req, res, next) {
    if (!req.session.officer) {
      return res.status(401).json({
        error: "يجب تسجيل الدخول أولاً"
      });
    }

    if (String(req.session.officer.role).toLowerCase() !== "admin") {
      return res.status(403).json({
        error: "ليست لديك صلاحية إدارة العملاء"
      });
    }

    next();
  }

  // تسجيل العملية في سجل العمليات
  async function writeAudit(client, officerId, action, details) {
    await client.query(
      `INSERT INTO audit_logs (officer_id, action, details)
       VALUES ($1, $2, $3)`,
      [officerId, action, details]
    );
  }

  // عرض جميع العملاء
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

  // إنشاء عميل جديد
  router.post("/", requireAdmin, async (req, res, next) => {
    const client = await pool.connect();

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

      const validRanks = Array.from(
        { length: 11 },
        (_, i) => `Agent ${i}`
      );

      if (!validRanks.includes(rank)) {
        return res.status(400).json({
          error: "الرتبة غير صحيحة"
        });
      }

      const passwordHash = await bcrypt.hash(password, 12);

      await client.query("BEGIN");

      const result = await client.query(
        `INSERT INTO officers
          (username, password_hash, full_name, rank, role, active)
         VALUES ($1, $2, $3, $4, 'officer', TRUE)
         RETURNING id, username, full_name, rank, role, active`,
        [username.trim(), passwordHash, full_name.trim(), rank]
      );

      const officer = result.rows[0];

      await writeAudit(
        client,
        req.session.officer.id,
        "CREATE_OFFICER",
        `تم إنشاء حساب العميل: ${officer.full_name} (${officer.username}) - الرتبة: ${officer.rank}`
      );

      await client.query("COMMIT");

      res.status(201).json({
        success: true,
        message: "تم إنشاء حساب العميل بنجاح",
        officer
      });
    } catch (error) {
      await client.query("ROLLBACK");

      if (error.code === "23505") {
        return res.status(409).json({
          error: "اسم المستخدم مستخدم بالفعل"
        });
      }

      next(error);
    } finally {
      client.release();
    }
  });

  // تعطيل أو تفعيل حساب عميل
  router.patch("/:id/status", requireAdmin, async (req, res, next) => {
    const client = await pool.connect();

    try {
      const { active } = req.body;

      if (typeof active !== "boolean") {
        return res.status(400).json({
          error: "حالة الحساب غير صحيحة"
        });
      }

      await client.query("BEGIN");

      const current = await client.query(
        `SELECT id, username, full_name, active
         FROM officers
         WHERE id = $1 AND role <> 'admin'
         FOR UPDATE`,
        [req.params.id]
      );

      if (current.rows.length === 0) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          error: "العميل غير موجود أو لا يمكن تعديل حسابه"
        });
      }

      const previous = current.rows[0];

      const result = await client.query(
        `UPDATE officers
         SET active = $1
         WHERE id = $2
         RETURNING id, username, full_name, active`,
        [active, req.params.id]
      );

      if (previous.active !== active) {
        await writeAudit(
          client,
          req.session.officer.id,
          active ? "ACTIVATE_OFFICER" : "DISABLE_OFFICER",
          `${active ? "تم تفعيل" : "تم تعطيل"} حساب العميل: ${previous.full_name} (${previous.username})`
        );
      }

      await client.query("COMMIT");

      res.json({
        success: true,
        message: active ? "تم تفعيل الحساب" : "تم تعطيل الحساب",
        officer: result.rows[0]
      });
    } catch (error) {
      await client.query("ROLLBACK");
      next(error);
    } finally {
      client.release();
    }
  });

  // حذف حساب عميل نهائياً
  router.delete("/:id", requireAdmin, async (req, res, next) => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(
        `DELETE FROM officers
         WHERE id = $1 AND role <> 'admin'
         RETURNING id, username, full_name`,
        [req.params.id]
      );

      if (result.rows.length === 0) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          error: "العميل غير موجود أو لا يمكن حذف حسابه"
        });
      }

      const officer = result.rows[0];

      await writeAudit(
        client,
        req.session.officer.id,
        "DELETE_OFFICER",
        `تم حذف حساب العميل: ${officer.full_name} (${officer.username})`
      );

      await client.query("COMMIT");

      res.json({
        success: true,
        message: "تم حذف حساب العميل",
        officer
      });
    } catch (error) {
      await client.query("ROLLBACK");

      if (error.code === "23503") {
        return res.status(409).json({
          error: "هذا العميل مرتبط بسجلات أخرى. عطّل حسابه بدلاً من حذفه."
        });
      }

      next(error);
    } finally {
      client.release();
    }
  });

  return router;
};
