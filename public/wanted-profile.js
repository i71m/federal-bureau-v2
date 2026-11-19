
(() => {
  const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);

  const statusLabels = {
    Active: "مطلوب",
    Arrested: "مقبوض عليه",
    Cleared: "تمت تبرئته"
  };

  const threatLabels = {
    Low: "منخفضة",
    Medium: "متوسطة",
    High: "مرتفعة",
    Critical: "حرجة"
  };

  const actionLabels = {
    CREATE: "تسجيل مطلوب جديد",
    UPDATE: "تعديل البيانات",
    STATUS_CHANGE: "تغيير الحالة",
    NOTE: "إضافة ملاحظة"
  };

  let currentWantedId = null;
  let currentImages = [];
  let loading = false;

  function formatDate(value) {
    if (!value) return "غير محدد";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "غير محدد";
    return date.toLocaleString("ar-SA");
  }

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      ...options
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || "تعذر تنفيذ الطلب");
    }

    return data;
  }

  function showMessage(id, message, success = false) {
    const element = document.getElementById(id);
    if (!element) return;

    element.textContent = message;
    element.style.color = success ? "#83d6a8" : "#ff8585";
  }

  function renderProfile(person) {
    const container = document.getElementById("wantedProfileContent");

    container.innerHTML = `
      <div class="profile-heading">
        <div>
          <div class="profile-kicker">FEDERAL BUREAU / WANTED FILE</div>
          <h2>${escapeHTML(person.full_name)}</h2>
          <p>رقم الملف: #${escapeHTML(person.id)}</p>
        </div>
        <button class="secondary" id="closeWantedProfile">العودة للقائمة</button>
      </div>

      <div class="profile-info-grid">
        <div class="profile-info">
          <span>الاسم المستعار</span>
          <strong>${escapeHTML(person.alias || "لا يوجد")}</strong>
        </div>
        <div class="profile-info">
          <span>مستوى الخطورة</span>
          <strong>${escapeHTML(threatLabels[person.threat_level] || person.threat_level || "غير محدد")}</strong>
        </div>
        <div class="profile-info">
          <span>الحالة</span>
          <strong>${escapeHTML(statusLabels[person.status] || person.status || "غير محددة")}</strong>
        </div>
        <div class="profile-info">
          <span>تاريخ التسجيل</span>
          <strong>${escapeHTML(formatDate(person.created_at))}</strong>
        </div>
      </div>

      <div class="profile-details-grid">
        <div class="profile-detail">
          <h3>التهم المسجلة</h3>
          <p>${escapeHTML(person.charges || "لا توجد تهم مسجلة")}</p>
        </div>
        <div class="profile-detail">
          <h3>الوصف والتفاصيل</h3>
          <p>${escapeHTML(person.description || "لا يوجد وصف مسجل")}</p>
        </div>
      </div>

      <div class="profile-section">
        <div class="profile-section-heading">
          <div>
            <h3>معرض الصور</h3>
            <p>الصور والمرفقات المرئية الخاصة بهذا المطلوب</p>
          </div>
          <label class="primary upload-label" for="wantedImageInput">
            إضافة صور
          </label>
          <input
            id="wantedImageInput"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            hidden
          >
        </div>

        <div id="wantedImageMessage" class="message"></div>
        <div id="wantedImagesGallery" class="wanted-gallery">
          <div class="empty">جارٍ تحميل الصور...</div>
        </div>
      </div>

      <div class="profile-section">
        <div class="profile-section-heading">
          <div>
            <h3>السجل التاريخي للملف</h3>
            <p>جميع التعديلات والإجراءات المسجلة على المطلوب</p>
          </div>
        </div>
        <div id="wantedHistoryList" class="wanted-timeline">
          <div class="empty">جارٍ تحميل السجل...</div>
        </div>
      </div>
    `;

    document.getElementById("closeWantedProfile").addEventListener("click", closeProfile);
    document.getElementById("wantedImageInput").addEventListener("change", uploadImages);
  }

  async function loadImages() {
    const gallery = document.getElementById("wantedImagesGallery");

    try {
      const data = await request(`/api/wanted-images/${currentWantedId}`);
      currentImages = data.images || [];

      gallery.innerHTML = "";

      if (!currentImages.length) {
        gallery.innerHTML = '<div class="empty">لا توجد صور لهذا المطلوب حتى الآن.</div>';
        return;
      }

      currentImages.forEach(image => {
        const card = document.createElement("div");
        card.className = "wanted-image-card";

        const img = document.createElement("img");
        img.src = `/api/wanted-images/file/${encodeURIComponent(image.id)}`;
        img.alt = image.image_name || "صورة مطلوب";
        img.loading = "lazy";
        img.addEventListener("click", () => openImage(img.src));

        const caption = document.createElement("div");
        caption.className = "wanted-image-caption";
        caption.textContent = image.image_name || "صورة";

        card.append(img, caption);
        gallery.appendChild(card);
      });
    } catch (error) {
      gallery.innerHTML = "";
      showMessage("wantedImageMessage", error.message);
    }
  }

  async function uploadImages(event) {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;

    const input = event.target;
    const button = document.querySelector(".upload-label");

    const invalid = files.find(file =>
      !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
      file.size > 5 * 1024 * 1024
    );

    if (invalid) {
      showMessage(
        "wantedImageMessage",
        "تأكد أن الصور بصيغة JPG أو PNG أو WEBP، وألا يتجاوز حجم الصورة 5 ميجابايت."
      );
      input.value = "";
      return;
    }

    button.style.opacity = "0.5";
    button.style.pointerEvents = "none";
    showMessage("wantedImageMessage", "جارٍ رفع الصور...");

    try {
      for (const file of files) {
        const formData = new FormData();
        formData.append("image", file);

        await request(`/api/wanted-images/${currentWantedId}`, {
          method: "POST",
          body: formData
        });
      }

      showMessage("wantedImageMessage", "تم رفع الصور بنجاح.", true);
      await loadImages();
    } catch (error) {
      showMessage("wantedImageMessage", error.message);
      await loadImages();
    } finally {
      button.style.opacity = "";
      button.style.pointerEvents = "";
      input.value = "";
    }
  }

  async function loadHistory() {
    const container = document.getElementById("wantedHistoryList");

    try {
      const data = await request(`/api/wanted-history/${currentWantedId}`);
      const history = data.history || [];

      container.innerHTML = "";

      if (!history.length) {
        container.innerHTML = '<div class="empty">لا يوجد سجل إجراءات حتى الآن.</div>';
        return;
      }

      history.forEach(item => {
        let details = item.details || "";

        try {
          const parsed = JSON.parse(details);
          if (parsed.message) {
            details = parsed.message;

            if (parsed.changes) {
              const changes = Object.entries(parsed.changes)
                .map(([key, value]) => {
                  const labels = {
                    full_name: "الاسم",
                    alias: "الاسم المستعار",
                    description: "الوصف",
                    charges: "التهم",
                    threat_level: "مستوى الخطورة",
                    status: "الحالة"
                  };

                  return `${labels[key] || key}: ${value.before ?? "—"} ← ${value.after ?? "—"}`;
                });

              details += "\n" + changes.join("\n");
            }
          }
        } catch (_) {}

        const entry = document.createElement("div");
        entry.className = "wanted-timeline-item";

        const title = document.createElement("strong");
        title.textContent = actionLabels[item.action] || item.action || "إجراء";

        const date = document.createElement("small");
        date.textContent = formatDate(item.created_at);

        const officer = document.createElement("div");
        officer.className = "timeline-officer";
        officer.textContent = `${item.officer_name || "ضابط غير معروف"} — ${item.officer_rank || "رتبة غير محددة"}`;

        const description = document.createElement("p");
        description.textContent = details || "لا توجد تفاصيل إضافية.";

        entry.append(title, date, officer, description);
        container.appendChild(entry);
      });
    } catch (error) {
      container.innerHTML = "";
      const message = document.createElement("div");
      message.className = "empty";
      message.textContent = error.message;
      container.appendChild(message);
    }
  }

  function openImage(src) {
    let modal = document.getElementById("wantedImageModal");

    if (!modal) {
      modal = document.createElement("div");
      modal.id = "wantedImageModal";
      modal.className = "wanted-image-modal";
      modal.innerHTML = `
        <button type="button" aria-label="إغلاق">×</button>
        <img alt="صورة مكبرة">
      `;
      document.body.appendChild(modal);

      modal.addEventListener("click", () => modal.classList.add("hidden"));
    }

    modal.querySelector("img").src = src;
    modal.classList.remove("hidden");
  }

  async function openProfile(id) {
    if (loading) return;
    loading = true;
    currentWantedId = id;

    const section = document.getElementById("wantedSection");
    const profile = document.getElementById("wantedProfileView");

    section.classList.add("hidden");
    profile.classList.remove("hidden");

    document.getElementById("wantedProfileContent").innerHTML =
      '<div class="empty">جارٍ تحميل ملف المطلوب...</div>';

    try {
      const person = await request("/api/wanted");
      const wanted = (person.wanted || []).find(item => String(item.id) === String(id));

      if (!wanted) throw new Error("لم يتم العثور على ملف المطلوب");

      renderProfile(wanted);
      await Promise.all([loadImages(), loadHistory()]);
    } catch (error) {
      document.getElementById("wantedProfileContent").innerHTML = "";
      const message = document.createElement("div");
      message.className = "empty";
      message.textContent = error.message;
      document.getElementById("wantedProfileContent").appendChild(message);
    } finally {
      loading = false;
    }
  }

  function closeProfile() {
    document.getElementById("wantedProfileView").classList.add("hidden");
    document.getElementById("wantedSection").classList.remove("hidden");
    currentWantedId = null;
    currentImages = [];
  }

  window.WantedProfile = {
    open: openProfile,
    close: closeProfile
  };
})();
