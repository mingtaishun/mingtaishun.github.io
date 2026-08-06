const menuToggle = document.querySelector(".menu-toggle");
const siteNav = document.querySelector("#site-nav");
const navDetails = [...document.querySelectorAll(".nav-group")];
const rfqForm = document.querySelector("#rfq-form");
const formFeedback = document.querySelector("#form-feedback");
const finderSummary = document.querySelector("#finder-summary");
const finderButton = document.querySelector("#use-finder");
const fileInput = document.querySelector("#attachments");
const fileStatus = document.querySelector("#file-status");
const selections = { material: "", process: "", problem: "" };

function setMenu(open) {
  menuToggle.setAttribute("aria-expanded", String(open));
  siteNav.classList.toggle("is-open", open);
  document.body.classList.toggle("menu-open", open);
}

menuToggle.addEventListener("click", () => {
  setMenu(menuToggle.getAttribute("aria-expanded") !== "true");
});

navDetails.forEach((details) => {
  details.addEventListener("toggle", () => {
    if (!details.open) return;
    navDetails.forEach((other) => {
      if (other !== details) other.open = false;
    });
  });
});

document.querySelectorAll('a[href^="#"]').forEach((link) => {
  link.addEventListener("click", () => {
    setMenu(false);
    navDetails.forEach((details) => { details.open = false; });
  });
});

function setRequestType(type) {
  const requestType = rfqForm.elements.requestType;
  const product = rfqForm.elements.product;
  if (type === "sample") requestType.value = "免费样品申请";
  if (type === "custom") {
    requestType.value = "非标刀具定制";
    product.value = "非标刀具";
  }
}

document.querySelectorAll("[data-request]").forEach((trigger) => {
  trigger.addEventListener("click", () => setRequestType(trigger.dataset.request));
});

document.querySelectorAll("[data-model]").forEach((trigger) => {
  trigger.addEventListener("click", () => {
    rfqForm.elements.model.value = trigger.dataset.model;
    rfqForm.elements.requestType.value = "产品询价";
    if (/APMT|SEKT|APKT|CCMT|WNMG/.test(trigger.dataset.model)) {
      rfqForm.elements.product.value = "硬质合金刀片";
    } else {
      rfqForm.elements.product.value = "整体硬质合金立铣刀";
    }
    document.querySelector("#rfq").scrollIntoView({ behavior: "smooth" });
  });
});

document.querySelectorAll(".finder-column").forEach((column) => {
  const group = column.dataset.group;
  column.querySelectorAll("button[data-value]").forEach((button) => {
    button.addEventListener("click", () => {
      const active = button.classList.contains("is-selected");
      column.querySelectorAll("button[data-value]").forEach((item) => {
        item.classList.remove("is-selected");
        item.setAttribute("aria-pressed", "false");
      });
      if (active) {
        selections[group] = "";
      } else {
        button.classList.add("is-selected");
        button.setAttribute("aria-pressed", "true");
        selections[group] = button.dataset.value;
      }
      updateFinder();
    });
    button.setAttribute("aria-pressed", "false");
  });
});

function updateFinder() {
  const parts = [];
  if (selections.material) parts.push(`材料：${selections.material}`);
  if (selections.process) parts.push(`工序：${selections.process}`);
  if (selections.problem) parts.push(`问题：${selections.problem}`);
  finderSummary.textContent = parts.length ? parts.join("  /  ") : "请选择至少一项工况信息";
  finderButton.disabled = parts.length === 0;
}

finderButton.addEventListener("click", () => {
  rfqForm.elements.requestType.value = "选型支持";
  if (selections.material) rfqForm.elements.material.value = selections.material;
  if (selections.process) rfqForm.elements.process.value = selections.process;
  if (selections.problem) rfqForm.elements.problem.value = `当前问题：${selections.problem}\n期望改善目标：`;
  document.querySelector("#rfq").scrollIntoView({ behavior: "smooth" });
  window.setTimeout(() => rfqForm.elements.name.focus({ preventScroll: true }), 500);
});

document.querySelector("#sample-request").addEventListener("click", () => {
  rfqForm.elements.requestType.value = "免费样品申请";
  rfqForm.elements.product.focus();
});

fileInput.addEventListener("change", () => {
  const files = [...fileInput.files];
  fileStatus.textContent = files.length
    ? `已选择 ${files.length} 个文件：${files.map((file) => file.name).join("、")}`
    : "支持 PDF / CAD / 图片 / 视频 / 表格 · 正式限制待确认";
});

rfqForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!rfqForm.reportValidity()) return;

  const data = Object.fromEntries(new FormData(rfqForm).entries());
  data.savedAt = new Date().toISOString();
  data.attachments = [...fileInput.files].map((file) => ({ name: file.name, size: file.size }));

  try {
    localStorage.setItem("mtslong-rfq-draft", JSON.stringify(data));
    formFeedback.textContent = "需求草稿已保存到当前浏览器。视觉稿不会把数据发送到外部；正式接入后可在这里显示询盘编号与负责人。";
  } catch (error) {
    formFeedback.textContent = "浏览器未能保存这份草稿。请检查隐私模式或存储权限后重试。";
  }
  formFeedback.classList.add("is-visible");
  formFeedback.scrollIntoView({ behavior: "smooth", block: "nearest" });
});

const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.08, rootMargin: "0px 0px -40px" });

document.querySelectorAll(".reveal").forEach((element) => observer.observe(element));

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setMenu(false);
    navDetails.forEach((details) => { details.open = false; });
  }
});

window.addEventListener("resize", () => {
  if (window.innerWidth > 980) setMenu(false);
});
