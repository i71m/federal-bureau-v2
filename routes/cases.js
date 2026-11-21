
const express = require("express");
const crypto = require("crypto");
const { authorize, isDirector } = require("../middleware/permissions");

module.exports = function (pool) {
  const router = express.Router();

  // التحقق من تسجيل الدخول
  function requireLogin(req, res, next) {
    if (!req.session || !req.session.officer) {
      return res.status(401).json({
        error: "يجب تسجيل الدخول أولاً"
      });
    }
    next();
  }

  // التحقق من رقم القضية
  function validCaseId(id) {
    return /^\d+$/.test(String(id));
  }

  // تسجيل العملية في سجل العمليات
  async function addAuditLog(db, officerId, action, details) {
    await db.query(
      `INSERT INTO audit_logs (officer_id, action, details)
       VALUES ($1, $2, $3)`,
      [officerId, action, details]
    );
  }

  // تسجيل الحدث في السجل التاريخي للقضية
  async function addCaseHistory(db, caseId, officerId, action, details) {
    await db.query(
      `INSERT INTO case_history
        (case_id, officer_id, action, details)
       VALUES ($1, $2, $3, $4::JSONB)`,
      [caseId, officerId, action, JSON.stringify(details)]
    );
  }

  // إنشاء رقم قضية تلقائي
  function generateCaseNumber() {
    const year = new Date().getFullYear();
    const code = crypto.randomBytes(3).toString("hex").toUpperCase();
    return `FB-${year}-${code}`;
  }

  // التحقق من الضابط المكلّف
  async function validateAssignedOfficer(db, assignedId) {
    if (assignedId === null) return true;

    const result = await db.query(
      "SELECT id FROM officers WHERE id = $1 AND active = TRUE",
      [assignedId]
    );

    return result.rows.length > 0;
  }

  // عرض القضايا غير المؤرشفة فقط
  router.get("/", requireLogin, async (req, res, next) => {
    try {
      const result = await pool.query(`
        SELECT
          c.*,
          assigned.full_name AS assigned_officer_name,
          creator.full_name AS creator_name
        FROM cases c
        LEFT JOIN officers assigned ON assigned.id = c.assigned_to
        LEFT JOIN officers creator ON creator.id = c.created_by
        WHERE c.archived_at IS NULL
        ORDER BY c.created_at DESC
      `);

      res.json(result.rows);
    } catch (error) {
      next(error);
    }
  });

  // عرض قضية محددة غير مؤرشفة
  router.get("/:id", requireLogin, async (req, res, next) => {
    if (!validCaseId(req.params.id)) {
      return res.status(400).json({
        error: "رقم القضية غير صالح"
      });
    }

    try {
      const result = await pool.query(`
        SELECT
          c.*,
          assigned.full_name AS assigned_officer_name,
          creator.full_name AS creator_name
        FROM cases c
        LEFT JOIN officers assigned ON assigned.id = c.assigned_to
        LEFT JOIN officers creator ON creator.id = c.created_by
        WHERE c.id = $1
          AND c.archived_at IS NULL
      `, [req.params.id]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "القضية غير موجودة"
        });
      }

      res.json(result.rows[0]);
    } catch (error) {
      next(error);
    }
  });

  // إنشاء قضية جديدة
  router.post("/", requireLogin, authorize("Agent 9"), async (req, res, next) => {
    let db;
    let transactionStarted = false;

    try {
      db = await pool.connect();

      const {
        title,
        description,
        status,
        priority,
        assigned_to
      } = req.body || {};

      if (
        typeof title !== "string" ||
        !title.trim() ||
        title.trim().length > 200
      ) {
        return res.status(400).json({
          error: "عنوان القضية مطلوب وبحد أقصى 200 حرف"
        });
      }

      if (
        description !== undefined &&
        description !== null &&
        typeof description !== "string"
      ) {
        return res.status(400).json({
          error: "وصف القضية غير صالح"
        });
      }

      if (description && description.length > 20000) {
        return res.status(400).json({
          error: "وصف القضية طويل جدًا"
        });
      }

      const caseStatus = status || "Open";
      const casePriority = priority || "Normal";

      if (
        typeof caseStatus !== "string" ||
        !caseStatus.trim() ||
        caseStatus.length > 30
      ) {
        return res.status(400).json({
          error: "حالة القضية غير صالحة"
        });
      }

      if (
        typeof casePriority !== "string" ||
        !casePriority.trim() ||
        casePriority.length > 30
      ) {
        return res.status(400).json({
          error: "أولوية القضية غير صالحة"
        });
      }

      const assignedId =
        assigned_to === "" ||
        assigned_to === undefined ||
        assigned_to === null
          ? null
          : Number(assigned_to);

      if (
        assignedId !== null &&
        (!Number.isSafeInteger(assignedId) || assignedId <= 0)
      ) {
        return res.status(400).json({
          error: "رقم الضابط المكلّف غير صحيح"
        });
      }

      if (!(await validateAssignedOfficer(db, assignedId))) {
        return res.status(400).json({
          error: "الضابط المحدد غير موجود أو غير نشط"
        });
      }

      await db.query("BEGIN");
      transactionStarted = true;

      const caseNumber = generateCaseNumber();

      const result = await db.query(
        `INSERT INTO cases
          (case_number, title, description, status, priority, assigned_to, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          caseNumber,
          title.trim(),
          description ? description.trim() : null,
          caseStatus.trim(),
          casePriority.trim(),
          assignedId,
          req.session.officer.id
        ]
      );

      const newCase = result.rows[0];

      await addCaseHistory(
        db,
        newCase.id,
        req.session.officer.id,
        "CREATE",
        {
          case_number: newCase.case_number,
          title: newCase.title,
          description: newCase.description,
          status: newCase.status,
          priority: newCase.priority,
          assigned_to: newCase.assigned_to
        }
      );

      await addAuditLog(
        db,
        req.session.officer.id,
        "CREATE_CASE",
        `تم إنشاء القضية ${newCase.case_number}: ${newCase.title}`
      );

      await db.query("COMMIT");
      transactionStarted = false;

      res.status(201).json({
        success: true,
        message: "تم إنشاء القضية بنجاح",
        case: newCase
      });

    } catch (error) {
      if (db && transactionStarted) {
        await db.query("ROLLBACK").catch(() => {});
      }
      next(error);
    } finally {
      if (db) db.release();
    }
  });

  // تعديل قضية غير مؤرشفة
  router.patch("/:id", requireLogin, authorize("Agent 8"), async (req, res, next) => {
    if (!validCaseId(req.params.id)) {
      return res.status(400).json({
        error: "رقم القضية غير صالح"
      });
    }

    let db;
    let transactionStarted = false;

    try {
      db = await pool.connect();

      const {
        title,
        description,
        status,
        priority,
        assigned_to
      } = req.body || {};

      const fields = [];
      const values = [];
      const changes = {};
      let index = 1;

      if (title !== undefined) {
        if (
          typeof title !== "string" ||
          !title.trim() ||
          title.trim().length > 200
        ) {
          return res.status(400).json({
            error: "عنوان القضية غير صالح"
          });
        }

        fields.push(`title = $${index++}`);
        values.push(title.trim());
      }

      if (description !== undefined) {
        if (description !== null && typeof description !== "string") {
          return res.status(400).json({
            error: "وصف القضية غير صالح"
          });
        }

        if (typeof description === "string" && description.length > 20000) {
          return res.status(400).json({
            error: "وصف القضية طويل جدًا"
          });
        }

        fields.push(`description = $${index++}`);
        values.push(
          typeof description === "string" && description.trim()
            ? description.trim()
            : null
        );
      }

      if (status !== undefined) {
        if (
          typeof status !== "string" ||
          !status.trim() ||
          status.length > 30
        ) {
          return res.status(400).json({
            error: "حالة القضية غير صالحة"
          });
        }

        fields.push(`status = $${index++}`);
        values.push(status.trim());
      }

      if (priority !== undefined) {
        if (
          typeof priority !== "string" ||
          !priority.trim() ||
          priority.length > 30
        ) {
          return res.status(400).json({
            error: "أولوية القضية غير صالحة"
          });
        }

        fields.push(`priority = $${index++}`);
        values.push(priority.trim());
      }

      if (assigned_to !== undefined) {
        const assignedId =
          assigned_to === "" || assigned_to === null
            ? null
            : Number(assigned_to);

        if (
          assignedId !== null &&
          (!Number.isSafeInteger(assignedId) || assignedId <= 0)
        ) {
          return res.status(400).json({
            error: "رقم الضابط المكلّف غير صحيح"
          });
        }

        if (!(await validateAssignedOfficer(db, assignedId))) {
          return res.status(400).json({
            error: "الضابط المحدد غير موجود أو غير نشط"
          });
        }

        fields.push(`assigned_to = $${index++}`);
        values.push(assignedId);
      }

      if (fields.length === 0) {
        return res.status(400).json({
          error: "لا توجد بيانات لتعديلها"
        });
      }

      await db.query("BEGIN");
      transactionStarted = true;

      const oldResult = await db.query(
        `SELECT * FROM cases
         WHERE id = $1 AND archived_at IS NULL
         FOR UPDATE`,
        [req.params.id]
      );

      if (oldResult.rows.length === 0) {
        await db.query("ROLLBACK");
        transactionStarted = false;

        return res.status(404).json({
          error: "القضية غير موجودة أو مؤرشفة"
        });
      }

      const oldCase = oldResult.rows[0];

      values.push(req.params.id);

      const result = await db.query(
        `UPDATE cases
         SET ${fields.join(", ")}, updated_at = NOW()
         WHERE id = $${index}
           AND archived_at IS NULL
         RETURNING *`,
        values
      );

      if (result.rows.length === 0) {
        await db.query("ROLLBACK");
        transactionStarted = false;

        return res.status(404).json({
          error: "القضية غير موجودة أو مؤرشفة"
        });
      }

      const updatedCase = result.rows[0];

      ["title", "description", "priority"].forEach(key => {
        if (oldCase[key] !== updatedCase[key]) {
          changes[key] = {
            before: oldCase[key],
            after: updatedCase[key]
          };
        }
      });

      if (Object.keys(changes).length > 0) {
        await addCaseHistory(
          db,
          updatedCase.id,
          req.session.officer.id,
          "UPDATE",
          changes
        );
      }

      if (oldCase.status !== updatedCase.status) {
        await addCaseHistory(
          db,
          updatedCase.id,
          req.session.officer.id,
          "STATUS_CHANGE",
          {
            before: oldCase.status,
            after: updatedCase.status
          }
        );
      }

      if (
        String(oldCase.assigned_to ?? "") !==
        String(updatedCase.assigned_to ?? "")
      ) {
        await addCaseHistory(
          db,
          updatedCase.id,
          req.session.officer.id,
          "ASSIGNMENT_CHANGE",
          {
            assigned_to: {
              before: oldCase.assigned_to,
              after: updatedCase.assigned_to
            }
          }
        );
      }

      await addAuditLog(
        db,
        req.session.officer.id,
        "UPDATE_CASE",
        `تم تعديل القضية ${updatedCase.case_number}`
      );

      await db.query("COMMIT");
      transactionStarted = false;

      res.json({
        success: true,
        message: "تم تحديث القضية بنجاح",
        case: updatedCase
      });

    } catch (error) {
      if (db && transactionStarted) {
        await db.query("ROLLBACK").catch(() => {});
      }
      next(error);
    } finally {
      if (db) db.release();
    }
  });

  // أرشفة قضية مباشرة - المدير العام فقط
  // لا يتم حذف سجل القضية أو ملاحظاتها أو أدلتها
  router.delete("/:id", requireLogin, (req, res, next) => {
    if (!isDirector(req.session.officer)) {
      return res.status(403).json({
        error: "الأرشفة المباشرة للقضايا متاحة للمدير العام فقط."
      });
    }
    next();
  }, async (req, res, next) => {
    if (!validCaseId(req.params.id)) {
      return res.status(400).json({
        error: "رقم القضية غير صالح"
      });
    }

    let db;
    let transactionStarted = false;

    try {
      db = await pool.connect();

      await db.query("BEGIN");
      transactionStarted = true;

      const result = await db.query(
        `UPDATE cases
         SET archived_at = NOW(),
             archived_by = $2,
             archive_reason = $3,
             updated_at = NOW()
         WHERE id = $1
           AND archived_at IS NULL
         RETURNING id, case_number, title`,
        [
          req.params.id,
          req.session.officer.id,
          "أرشفة مباشرة بواسطة المدير العام"
        ]
      );

      if (result.rows.length === 0) {
        await db.query("ROLLBACK");
        transactionStarted = false;

        return res.status(404).json({
          error: "القضية غير موجودة أو مؤرشفة مسبقًا"
        });
      }

      const archivedCase = result.rows[0];

      await addCaseHistory(
        db,
        archivedCase.id,
        req.session.officer.id,
        "ARCHIVE",
        {
          case_number: archivedCase.case_number,
          title: archivedCase.title,
          reason: "أرشفة مباشرة بواسطة المدير العام"
        }
      );

      await addAuditLog(
        db,
        req.session.officer.id,
        "ARCHIVE_CASE",
        `تمت أرشفة القضية ${archivedCase.case_number}: ${archivedCase.title}`
      );

      await db.query("COMMIT");
      transactionStarted = false;

      res.json({
        success: true,
        message: "تمت أرشفة القضية بنجاح. لم يتم حذف أي بيانات."
      });

    } catch (error) {
      if (db && transactionStarted) {
        await db.query("ROLLBACK").catch(() => {});
      }
      next(error);
    } finally {
      if (db) db.release();
    }
  });

  return router;
};
