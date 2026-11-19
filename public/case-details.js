
(() => {
  const API = "/api";
  let currentCaseId = null;

  const escapeHTML = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[char]));

  const getData = async (url, options = {}) => {
    const response = await fetch(url, {
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      },
      ...options
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.message || data.error || "تعذر تنفيذ الطلب");
    }

    return data;
  };

  const unwrap = (data, keys) => {
    if (Array.isArray(data)) return data;

    for (const key of keys) {
      if (Array.isArray(data?.[key])) return data[key];
    }

    return [];
  };

  const formatDate = (value) => {
    if (!value) return "—";

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";

    return date.toLocaleString("ar-SA", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  };

  const statusLabel = (status) => {
    const labels = {
      Open: "مفتوحة",
      Closed: "مغلقة",
      Pending: "قيد الانتظار",
      UnderReview: "قيد المراجعة",
      "In Progress": "قيد العمل"
    };
    return labels[status] || status || "—";
  };

  const priorityLabel = (priority) => {
    const labels = {
      Low: "منخفضة",
      Normal: "عادية",
      Medium: "متوسطة",
      High: "مرتفعة",
      Critical: "حرجة"
    };
    return labels[priority] || priority || "—";
  };

  function createModal() {
    if (document.getElementById("caseProfileModal")) return;

    const modal = document.createElement("div");
    modal.id = "caseProfileModal";

    modal.innerHTML = `
      <div class="case-profile-overlay" onclick="closeCaseProfile()"></div>

      <div class="case-profile-window" role="dialog" aria-modal="true">
        <div class="case-profile-header">
          <div>
            <div class="case-profile-eyebrow">FEDERAL BUREAU</div>
            <h2>ملف القضية</h2>
            <div id="caseProfileNumber" class="case-profile-number"></div>
          </div>
          <button type="button" class="case-profile-close"
            onclick="closeCaseProfile()">✕</button>
        </div>

        <div id="caseProfileContent" class="case-profile-content">
          <div class="case-profile-loading">جارٍ تحميل بيانات القضية...</div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const style = document.createElement("style");
    style.textContent = `
      #caseProfileModal {
        position: fixed;
        inset: 0;
        z-index: 99999;
        display: none;
        direction: rtl;
        font-family: inherit;
      }

      #caseProfileModal.active { display: block; }

      .case-profile-overlay {
        position: absolute;
        inset: 0;
        background: rgba(0,0,0,.78);
        backdrop-filter: blur(5px);
      }

      .case-profile-window {
        position: relative;
        width: min(950px, calc(100% - 28px));
        max-height: 90vh;
        overflow-y: auto;
        margin: 5vh auto;
        background: #0d1728;
        border: 1px solid #34445c;
        border-radius: 15px;
        color: #e9edf5;
        box-shadow: 0 20px 70px rgba(0,0,0,.55);
      }

      .case-profile-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 22px 25px;
        border-bottom: 1px solid #26364c;
        background: #111e32;
      }

      .case-profile-header h2 {
        margin: 5px 0;
        font-size: 23px;
      }

      .case-profile-eyebrow {
        color: #c5a45e;
        font-size: 11px;
        letter-spacing: 2px;
      }

      .case-profile-number {
        color: #aab8ca;
        font-size: 13px;
      }

      .case-profile-close {
        border: 1px solid #45546a;
        background: #1a2940;
        color: white;
        border-radius: 8px;
        padding: 8px 12px;
        cursor: pointer;
      }

      .case-profile-content { padding: 22px 25px; }

      .case-profile-loading,
      .case-profile-empty {
        padding: 25px;
        text-align: center;
        color: #aab8ca;
      }

      .case-profile-info {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px;
        margin-bottom: 24px;
      }

      .case-profile-field {
        padding: 14px;
        background: #142238;
        border: 1px solid #293c55;
        border-radius: 9px;
        min-width: 0;
      }

      .case-profile-field small {
        display: block;
        color: #91a1b6;
        margin-bottom: 7px;
      }

      .case-profile-field strong {
        display: block;
        overflow-wrap: anywhere;
        color: #f0d18a;
        font-size: 14px;
      }

      .case-profile-description {
        padding: 16px;
        margin-bottom: 24px;
        background: #142238;
        border: 1px solid #293c55;
        border-radius: 9px;
      }

      .case-profile-description h3 {
        margin: 0 0 10px;
        color: #f0d18a;
        font-size: 15px;
      }

      .case-profile-description p {
        margin: 0;
        white-space: pre-wrap;
        line-height: 1.8;
        color: #d4dce8;
      }

      .case-profile-tabs {
        display: flex;
        gap: 8px;
        border-bottom: 1px solid #34445c;
        margin-bottom: 18px;
      }

      .case-profile-tab {
        border: 0;
        border-bottom: 2px solid transparent;
        padding: 12px 18px;
        background: transparent;
        color: #aab8ca;
        cursor: pointer;
        font: inherit;
      }

      .case-profile-tab.active {
        color: #f0d18a;
        border-bottom-color: #c5a45e;
      }

      .case-profile-entry {
        padding: 14px;
        margin-bottom: 10px;
        background: #142238;
        border: 1px solid #293c55;
        border-radius: 9px;
      }

      .case-profile-entry-title {
        color: #f0d18a;
        font-weight: bold;
        margin-bottom: 7px;
      }

      .case-profile-entry-meta {
        color: #91a1b6;
        font-size: 12px;
        margin-bottom: 8px;
      }

      .case-profile-entry-text {
        color: #d4dce8;
        line-height: 1.8;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }

      .case-profile-note-form {
        margin-top: 18px;
        padding: 16px;
        background: #111e32;
        border: 1px solid #34445c;
        border-radius: 10px;
      }

      .case-profile-note-form textarea {
        display: block;
        width: 100%;
        min-height: 100px;
        resize: vertical;
        box-sizing: border-box;
        padding: 12px;
        border: 1px solid #40516a;
        border-radius: 8px;
        background: #0b1525;
        color: white;
        font: inherit;
        margin-bottom: 12px;
      }

      .case-profile-note-form button {
        border: 1px solid #b18e4c;
        border-radius: 7px;
        background: #b18e4c;
        color: #101827;
        padding: 10px 18px;
        cursor: pointer;
        font: inherit;
        font-weight: bold;
      }

      .case-profile-message {
        margin-top: 10px;
        font-size: 13px;
        color: #f0d18a;
      }

      @media(max-width:600px) {
        .case-profile-window {
          width: calc(100% - 14px);
          margin: 2vh auto;
          max-height: 96vh;
        }
        .case-profile-content { padding: 15px; }
        .case-profile-header { padding: 16px; }
      }
    `;

    document.head.appendChild(style);
  }

  function showTab(tab) {
    const historyPanel = document.getElementById("caseHistoryPanel");
    const notesPanel = document.getElementById("caseNotesPanel");

    if (!historyPanel || !notesPanel) return;

    historyPanel.style.display = tab === "history" ? "block" : "none";
    notesPanel.style.display = tab === "notes" ? "block" : "none";

    document.querySelectorAll(".case-profile-tab").forEach((button) => {
      button.classList.toggle("active", button.dataset.tab === tab);
    });
  }

  function renderHistory(items) {
    if (!items.length) {
      return `<div class="case-profile-empty">لا يوجد سجل تاريخي لهذه القضية حتى الآن</div>`;
    }

    return items.map((item) => {
      let details = item.details;

      if (typeof details === "object" && details !== null) {
        details = JSON.stringify(details, null, 2);
      }

      return `
        <div class="case-profile-entry">
          <div class="case-profile-entry-title">
            ${escapeHTML(item.action || "تحديث")}
          </div>
          <div class="case-profile-entry-meta">
            ${escapeHTML(item.full_name || item.username || "النظام")}
            ${item.rank ? " — " + escapeHTML(item.rank) : ""}
            · ${escapeHTML(formatDate(item.created_at))}
          </div>
          ${details ? `<div class="case-profile-entry-text">${escapeHTML(details)}</div>` : ""}
        </div>
      `;
    }).join("");
  }

  function renderNotes(items) {
    if (!items.length) {
      return `<div class="case-profile-empty">لا توجد ملاحظات مسجلة لهذه القضية</div>`;
    }

    return items.map((item) => `
      <div class="case-profile-entry">
        <div class="case-profile-entry-meta">
          ${escapeHTML(item.full_name || item.username || "ضابط")}
          ${item.rank ? " — " + escapeHTML(item.rank) : ""}
          · ${escapeHTML(formatDate(item.created_at))}
        </div>
        <div class="case-profile-entry-text">${escapeHTML(item.note)}</div>
      </div>
    `).join("");
  }

  async function loadCaseProfile(caseId) {
    currentCaseId = caseId;
    createModal();

    const modal = document.getElementById("caseProfileModal");
    const content = document.getElementById("caseProfileContent");

    modal.classList.add("active");
    document.body.style.overflow = "hidden";
    content.innerHTML = `<div class="case-profile-loading">جارٍ تحميل بيانات القضية...</div>`;

    try {
      const [caseData, historyData, notesData] = await Promise.all([
        getData(`${API}/cases/${caseId}`),
        getData(`${API}/case-history/${caseId}`),
        getData(`${API}/case-history/notes/${caseId}`)
      ]);

      const record = caseData.case || caseData.data || caseData;
      const history = unwrap(historyData, ["history", "data", "records"]);
      const notes = unwrap(notesData, ["notes", "data", "records"]);

      document.getElementById("caseProfileNumber").textContent =
        record.case_number || `رقم القضية: ${caseId}`;

      content.innerHTML = `
        <div class="case-profile-info">
          <div class="case-profile-field">
            <small>عنوان القضية</small>
            <strong>${escapeHTML(record.title || "—")}</strong>
          </div>
          <div class="case-profile-field">
            <small>الحالة</small>
            <strong>${escapeHTML(statusLabel(record.status))}</strong>
          </div>
          <div class="case-profile-field">
            <small>الأولوية</small>
            <strong>${escapeHTML(priorityLabel(record.priority))}</strong>
          </div>
          <div class="case-profile-field">
            <small>الضابط المكلّف</small>
            <strong>${escapeHTML(record.assigned_officer_name || "غير محدد")}</strong>
          </div>
          <div class="case-profile-field">
            <small>منشئ القضية</small>
            <strong>${escapeHTML(record.creator_name || "—")}</strong>
          </div>
          <div class="case-profile-field">
            <small>تاريخ الإنشاء</small>
            <strong>${escapeHTML(formatDate(record.created_at))}</strong>
          </div>
        </div>

        <div class="case-profile-description">
          <h3>وصف القضية</h3>
          <p>${escapeHTML(record.description || "لا يوجد وصف مسجل")}</p>
        </div>

        <div class="case-profile-tabs">
          <button type="button" class="case-profile-tab active"
            data-tab="history" onclick="caseProfileTab('history')">
            السجل التاريخي (${history.length})
          </button>
          <button type="button" class="case-profile-tab"
            data-tab="notes" onclick="caseProfileTab('notes')">
            الملاحظات (${notes.length})
          </button>
        </div>

        <section id="caseHistoryPanel">
          ${renderHistory(history)}
        </section>

        <section id="caseNotesPanel" style="display:none">
          <div id="caseNotesList">${renderNotes(notes)}</div>

          <form class="case-profile-note-form" id="caseProfileNoteForm">
            <h3 style="margin:0 0 12px;color:#f0d18a">إضافة ملاحظة جديدة</h3>
            <textarea id="caseProfileNoteText"
              placeholder="اكتب الملاحظة هنا..." required maxlength="10000"></textarea>
            <button type="submit">حفظ الملاحظة</button>
            <div id="caseProfileNoteMessage" class="case-profile-message"></div>
          </form>
        </section>
      `;

      document.getElementById("caseProfileNoteForm")
        .addEventListener("submit", saveCaseNote);

    } catch (error) {
      content.innerHTML = `
        <div class="case-profile-empty">
          تعذر تحميل ملف القضية: ${escapeHTML(error.message)}
        </div>
      `;
    }
  }

  async function saveCaseNote(event) {
    event.preventDefault();

    const textarea = document.getElementById("caseProfileNoteText");
    const message = document.getElementById("caseProfileNoteMessage");
    const note = textarea.value.trim();

    if (!note) {
      message.textContent = "اكتب الملاحظة أولاً";
      return;
    }

    try {
      message.textContent = "جارٍ حفظ الملاحظة...";

      await getData(`${API}/case-history/notes/${currentCaseId}`, {
        method: "POST",
        body: JSON.stringify({ note })
      });

      await loadCaseProfile(currentCaseId);
      showTab("notes");

      const updatedMessage = document.getElementById("caseProfileNoteMessage");
      if (updatedMessage) updatedMessage.textContent = "تم حفظ الملاحظة بنجاح";

    } catch (error) {
      message.textContent = error.message;
    }
  }

  window.caseProfileTab = showTab;

  window.closeCaseProfile = function () {
    const modal = document.getElementById("caseProfileModal");
    if (modal) modal.classList.remove("active");
    document.body.style.overflow = "";
    currentCaseId = null;
  };

  // يستبدل وظيفة زر "عرض" القديمة في جدول القضايا
  window.viewCase = function (caseId) {
    loadCaseProfile(caseId);
  };

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") window.closeCaseProfile();
  });
})();
