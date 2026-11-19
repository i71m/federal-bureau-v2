
module.exports = function (pool) {
  const express = require("express");
  const router = express.Router();

  function requireLogin(req, res, next) {
    if (!req.session.officer) {
      return res.status(401).json({
        error: "يجب تسجيل الدخول أولاً"
      });
    }
    next();
  }

  function requireText(value, maxLength) {
    return typeof value === "string" &&
      value.trim().length > 0 &&
      value.trim().length <= maxLength;
  }

  const statuses = ["مفتوحة", "قيد التحقيق", "مغلقة"];
  const secrecyLevels = ["عادي", "سري", "سري للغاية"];

  // عرض القضايا
  router.get("/", requireLogin, async (req, res, next) => {
    try {
      const search = String(req.query.search || "").trim();

      const result = await pool.query(
        `SELECT c.*, o.username AS created_by_username,
                o.full_name AS created_by_name
         FROM cases c
         LEFT JOIN officers o ON o.id = c.created_by
         WHERE c.title ILIKE $1
            OR COALESCE(c.description, '') ILIKE $1
            OR COALESCE(c.category, '') ILIKE $1
         ORDER BY c.created_at DESC
         LIMIT 200`,
        [`%${search}%`]
      );

      res.json({
        success: true,
        cases: result.rows
      });
    } catch (error) {
      next(error);
    }
  });

  // إنشاء قضية
  router.post("/", requireLogin, async (req, res, next) => {
    const {
      title,
      description,
      category,
      status,
      secrecy_level
    } = req.body;

    if (!requireText(title, 200)) {
      return res.status(400).json({
        error: "عنوان القضية مطلوب، وبحد أقصى 200 حرف"
      });
    }

    if (description && (
      typeof description !== "string" ||
      description.length > 10000
    )) {
      return res.status(400).json({
        error: "وصف القضية غير صالح"
      });
    }

    if (category && (
      typeof category !== "string" ||
      category.length > 100
    )) {
      return res.status(400).json({
        error: "تصنيف القضية غير صالح"
      });
    }

    if (status && !statuses.includes(status)) {
      return res.status(400).json({
        error: "حالة القضية غير صالحة"
      });
    }

    if (secrecy_level && !secrecyLevels.includes(secrecy_level)) {
      return res.status(400).json({
        error: "درجة السرية غير صالحة"
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(
        `INSERT INTO cases
          (title, description, category, status, secrecy_level, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          title.trim(),
          description ? description.trim() : null,
          category ? category.trim() : "عام",
          status || "مفتوحة",
          secrecy_level || "عادي",
          req.session.officer.id
        ]
      );

      const newCase = result.rows[0];

      await client.query(
        `INSERT INTO audit_logs (officer_id, action, details)
         VALUES ($1, $2, $3)`,
        [
          req.session.officer.id,
          "CREATE_CASE",
          `إنشاء القضية: ${newCase.title}`
        ]
      );

      await client.query("COMMIT");

      res.status(201).json({
        success: true,
        message: "تم إنشاء القضية بنجاح",
        case: newCase
      });
    } catch (error) {
      await client.query("ROLLBACK");
      next(error);
    } finally {
      client.release();
    }
  });

  // تحديث قضية
  router.patch("/:id", requireLogin, async (req, res, next) => {
    const {
      title,
      description,
      category,
      status,
      secrecy_level
    } = req.body;

    if (title !== undefined && !requireText(title, 200)) {
      return res.status(400).json({
        error: "عنوان القضية غير صالح"
      });
    }

    if (description !== undefined &&
        (typeof description !== "string" || description.length > 10000)) {
      return res.status(400).json({
        error: "وصف القضية غير صالح"
      });
    }

    if (category !== undefined &&
        (typeof category !== "string" || category.length > 100)) {
      return res.status(400).json({
        error: "تصنيف القضية غير صالح"
      });
    }

    if (status !== undefined && !statuses.includes(status)) {
      return res.status(400).json({
        error: "حالة القضية غير صالحة"
      });
    }

    if (secrecy_level !== undefined &&
        !secrecyLevels.includes(secrecy_level)) {
      return res.status(400).json({
        error: "درجة السرية غير صالحة"
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(
        `UPDATE cases SET
          title = COALESCE($1, title),
          description = COALESCE($2, description),
          category = COALESCE($3, category),
          status = COALESCE($4, status),
          secrecy_level = COALESCE($5, secrecy_level)
         WHERE id = $6
         RETURNING *`,
        [
          title === undefined ? null : title.trim(),
          description === undefined ? null : description.trim(),
          category === undefined ? null : category.trim(),
          status === undefined ? null : status,
          secrecy_level === undefined ? null : secrecy_level,
          req.params.id
        ]
      );

      if (result.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          error: "القضية غير موجودة"
        });
      }

      await client.query(
        `INSERT INTO audit_logs (officer_id, action, details)
         VALUES ($1, $2, $3)`,
        [
          req.session.officer.id,
          "UPDATE_CASE",
          `تحديث القضية: ${result.rows[0].title}`
        ]
      );

      await client.query("COMMIT");

      res.json({
        success: true,
        message: "تم تحديث القضية بنجاح",
        case: result.rows[0]
      });
    } catch (error) {
      await client.query("ROLLBACK");
      next(error);
    } finally {
      client.release();
    }
  });

  // حذف قضية - للمدير أو منشئ القضية
  router.delete("/:id", requireLogin, async (req, res, next) => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(
        "SELECT * FROM cases WHERE id = $1 FOR UPDATE",
        [req.params.id]
      );

      if (result.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          error: "القضية غير موجودة"
        });
      }

      const existingCase = result.rows[0];
      const isAdmin =
        String(req.session.officer.role).toLowerCase() === "admin";

      if (
        !isAdmin &&
        String(existingCase.created_by) !== String(req.session.officer.id)
      ) {
        await client.query("ROLLBACK");
        return res.status(403).json({
          error: "لا تملك صلاحية حذف هذه القضية"
        });
      }

      await client.query(
        "DELETE FROM cases WHERE id = $1",
        [req.params.id]
      );

      await client.query(
        `INSERT INTO audit_logs (officer_id, action, details)
         VALUES ($1, $2, $3)`,
        [
          req.session.officer.id,
          "DELETE_CASE",
          `حذف القضية: ${existingCase.title}`
        ]
      );

      await client.query("COMMIT");

      res.json({
        success: true,
        message: "تم حذف القضية بنجاح"
      });
    } catch (error) {
      await client.query("ROLLBACK");
      next(error);
    } finally {
      client.release();
    }
  });

  return router;
};
