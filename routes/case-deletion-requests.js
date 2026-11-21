
const express = require("express");
const {
  authorize,
  isDirector
} = require("../middleware/permissions");

module.exports = function (pool) {
  const router = express.Router();

  // =========================================
  // سجل العمليات
  // =========================================

  async function addAuditLog(client, officerId, action, details) {
    await client.query(
      `INSERT INTO audit_logs
       (officer_id, action, details)
       VALUES ($1, $2, $3)`,
      [officerId, action, JSON.stringify(details)]
    );
  }

  // =========================================
  // عرض طلبات الحذف - Agent 5 وما فوق
  // =========================================

  router.get(
    "/",
    authorize("Agent 5"),
    async (req, res, next) => {
      try {
        const result = await pool.query(
          `SELECT
             r.*,
             c.case_number,
             c.title AS case_title,
             o.full_name AS requester_name,
             o.rank AS requester_rank,
             reviewer.full_name AS reviewer_name
           FROM case_deletion_requests r
           JOIN cases c ON c.id = r.case_id
           LEFT JOIN officers o ON o.id = r.requested_by
           LEFT JOIN officers reviewer ON reviewer.id = r.reviewed_by
           ORDER BY
             CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END,
             r.created_at DESC`
        );

        res.json({
          success: true,
          requests: result.rows
        });
      } catch (error) {
        next(error);
      }
    }
  );

  // =========================================
  // تقديم طلب حذف قضية - Agent 7 وما فوق
  // =========================================

  router.post(
    "/:caseId",
    authorize("Agent 7"),
    async (req, res, next) => {
      const caseId = String(req.params.caseId || "");
      const reason = String(req.body.reason || "").trim();

      if (!/^\d+$/.test(caseId)) {
        return res.status(400).json({
          success: false,
          error: "رقم القضية غير صحيح."
        });
      }

      if (reason.length < 5 || reason.length > 1000) {
        return res.status(400).json({
          success: false,
          error: "يجب كتابة سبب واضح من 5 إلى 1000 حرف."
        });
      }

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        const caseResult = await client.query(
          `SELECT id, case_number, archived_at
           FROM cases
           WHERE id = $1
           FOR UPDATE`,
          [caseId]
        );

        if (caseResult.rows.length === 0) {
          await client.query("ROLLBACK");
          return res.status(404).json({
            success: false,
            error: "القضية غير موجودة."
          });
        }

        if (caseResult.rows[0].archived_at) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            success: false,
            error: "القضية مؤرشفة بالفعل."
          });
        }

        const existing = await client.query(
          `SELECT id
           FROM case_deletion_requests
           WHERE case_id = $1
           AND status = 'pending'`,
          [caseId]
        );

        if (existing.rows.length > 0) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            success: false,
            error: "يوجد طلب حذف قيد المراجعة لهذه القضية."
          });
        }

        const result = await client.query(
          `INSERT INTO case_deletion_requests
           (case_id, requested_by, reason)
           VALUES ($1, $2, $3)
           RETURNING *`,
          [caseId, req.session.officer.id, reason]
        );

        await addAuditLog(
          client,
          req.session.officer.id,
          "CASE_DELETION_REQUESTED",
          {
            case_id: caseId,
            reason
          }
        );

        await client.query("COMMIT");

        res.status(201).json({
          success: true,
          message: "تم تقديم طلب حذف القضية للمراجعة.",
          request: result.rows[0]
        });

      } catch (error) {
        await client.query("ROLLBACK");

        if (error.code === "23505") {
          return res.status(409).json({
            success: false,
            error: "يوجد طلب حذف قيد المراجعة لهذه القضية."
          });
        }

        next(error);

      } finally {
        client.release();
      }
    }
  );

  // =========================================
  // اعتماد أو رفض الطلب - Agent 5 وما فوق
  // =========================================

  router.patch(
    "/:id/review",
    authorize("Agent 5"),
    async (req, res, next) => {
      const requestId = String(req.params.id || "");
      const decision = String(req.body.decision || "").toLowerCase();

      if (!/^\d+$/.test(requestId)) {
        return res.status(400).json({
          success: false,
          error: "رقم الطلب غير صحيح."
        });
      }

      if (!["approve", "reject"].includes(decision)) {
        return res.status(400).json({
          success: false,
          error: "القرار يجب أن يكون approve أو reject."
        });
      }

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        const requestResult = await client.query(
          `SELECT *
           FROM case_deletion_requests
           WHERE id = $1
           FOR UPDATE`,
          [requestId]
        );

        if (requestResult.rows.length === 0) {
          await client.query("ROLLBACK");
          return res.status(404).json({
            success: false,
            error: "طلب الحذف غير موجود."
          });
        }

        const deletionRequest = requestResult.rows[0];

        if (deletionRequest.status !== "pending") {
          await client.query("ROLLBACK");
          return res.status(409).json({
            success: false,
            error: "تمت مراجعة هذا الطلب مسبقاً."
          });
        }

        if (
          String(deletionRequest.requested_by) ===
          String(req.session.officer.id)
        ) {
          await client.query("ROLLBACK");
          return res.status(403).json({
            success: false,
            error: "لا يمكنك مراجعة طلب الحذف الذي قدمته بنفسك."
          });
        }

        if (decision === "approve") {
          const caseResult = await client.query(
            `SELECT id, archived_at
             FROM cases
             WHERE id = $1
             FOR UPDATE`,
            [deletionRequest.case_id]
          );

          if (caseResult.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({
              success: false,
              error: "القضية المرتبطة بالطلب غير موجودة."
            });
          }

          if (caseResult.rows[0].archived_at) {
            await client.query("ROLLBACK");
            return res.status(409).json({
              success: false,
              error: "القضية مؤرشفة بالفعل."
            });
          }

          await client.query(
            `UPDATE cases
             SET archived_at = NOW(),
                 archived_by = $1,
                 archive_reason = $2,
                 updated_at = NOW()
             WHERE id = $3`,
            [
              req.session.officer.id,
              deletionRequest.reason,
              deletionRequest.case_id
            ]
          );
        }

        const newStatus =
          decision === "approve" ? "approved" : "rejected";

        const updated = await client.query(
          `UPDATE case_deletion_requests
           SET status = $1,
               reviewed_by = $2,
               reviewed_at = NOW()
           WHERE id = $3
           RETURNING *`,
          [
            newStatus,
            req.session.officer.id,
            requestId
          ]
        );

        await addAuditLog(
          client,
          req.session.officer.id,
          decision === "approve"
            ? "CASE_DELETION_APPROVED"
            : "CASE_DELETION_REJECTED",
          {
            request_id: requestId,
            case_id: deletionRequest.case_id
          }
        );

        await client.query("COMMIT");

        res.json({
          success: true,
          message: decision === "approve"
            ? "تم اعتماد الطلب وأرشفة القضية مع الاحتفاظ بسجلاتها."
            : "تم رفض طلب الحذف.",
          request: updated.rows[0]
        });

      } catch (error) {
        await client.query("ROLLBACK");
        next(error);

      } finally {
        client.release();
      }
    }
  );

  // =========================================
  // أرشيف القضايا - المدير العام فقط
  // =========================================

  router.get(
    "/archive",
    async (req, res, next) => {
      if (!isDirector(req.session.officer)) {
        return res.status(403).json({
          success: false,
          error: "الأرشيف متاح للمدير العام فقط."
        });
      }

      try {
        const result = await pool.query(
          `SELECT
             c.*,
             archived_by.full_name AS archived_by_name
           FROM cases c
           LEFT JOIN officers archived_by
             ON archived_by.id = c.archived_by
           WHERE c.archived_at IS NOT NULL
           ORDER BY c.archived_at DESC`
        );

        res.json({
          success: true,
          archive: result.rows
        });
      } catch (error) {
        next(error);
      }
    }
  );

  // =========================================
  // استعادة قضية من الأرشيف - المدير العام فقط
  // =========================================

  router.post(
    "/archive/:caseId/restore",
    async (req, res, next) => {
      if (!isDirector(req.session.officer)) {
        return res.status(403).json({
          success: false,
          error: "استعادة القضايا متاحة للمدير العام فقط."
        });
      }

      const caseId = String(req.params.caseId || "");

      if (!/^\d+$/.test(caseId)) {
        return res.status(400).json({
          success: false,
          error: "رقم القضية غير صحيح."
        });
      }

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        const result = await client.query(
          `UPDATE cases
           SET archived_at = NULL,
               archived_by = NULL,
               archive_reason = NULL,
               updated_at = NOW()
           WHERE id = $1
             AND archived_at IS NOT NULL
           RETURNING id, case_number, title`,
          [caseId]
        );

        if (result.rows.length === 0) {
          await client.query("ROLLBACK");
          return res.status(404).json({
            success: false,
            error: "القضية غير موجودة في الأرشيف."
          });
        }

        await addAuditLog(
          client,
          req.session.officer.id,
          "CASE_RESTORED_FROM_ARCHIVE",
          {
            case_id: caseId
          }
        );

        await client.query("COMMIT");

        res.json({
          success: true,
          message: "تمت استعادة القضية بنجاح.",
          case: result.rows[0]
        });

      } catch (error) {
        await client.query("ROLLBACK");
        next(error);

      } finally {
        client.release();
      }
    }
  );

  return router;
};
