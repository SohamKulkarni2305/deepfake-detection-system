/* ---------- UTILITY FUNCTIONS (Global) ---------- */
function toggle() {
    const loginBox = document.getElementById("login-box");
    const registerBox = document.getElementById("register-box");
    loginBox.classList.toggle("hidden");
    registerBox.classList.toggle("hidden");
}

function shakeError(msg) {
    const authCard = document.querySelector(".auth-card") || document.querySelector(".auth-wrapper");
    if (authCard) {
        authCard.classList.add("error");
        setTimeout(() => authCard.classList.remove("error"), 450);
    }
    console.error(msg);
}

/* ---------- AUTHENTICATION ---------- */
async function register() {
    const regBtn = document.querySelector('#register-box .auth-btn');
    const regName = document.getElementById("reg-name").value;
    const regEmail = document.getElementById("reg-email").value;
    const regPass = document.getElementById("reg-pass").value;

    if (!regName || !regEmail || !regPass) {
        shakeError("Registration failed: All fields are required");
        return;
    }

    regBtn.classList.add("loading");
    regBtn.disabled = true;

    try {
        const response = await fetch("/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: regName, email: regEmail, pass: regPass })
        });

        const data = await response.json();
        if (data.success) {
            alert("Account created successfully! Please login.");
            toggle();
        } else {
            shakeError(data.message || "Registration failed");
        }
    } catch {
        shakeError("Network error. Please try again later.");
    } finally {
        regBtn.classList.remove("loading");
        regBtn.disabled = false;
    }
}

async function login() {
    const loginEmail = document.getElementById("login-email");
    const loginPass = document.getElementById("login-pass");
    const loginBtn = document.getElementById("login-btn");

    if (!loginEmail.value || !loginPass.value) {
        shakeError("Fields cannot be empty");
        return;
    }

    loginBtn.classList.add("loading");

    const formData = new FormData();
    formData.append("email", loginEmail.value);
    formData.append("password", loginPass.value);

    try {
        const res = await fetch("/login", { method: "POST", body: formData });
        const data = await res.json();

        if (data.success) {
            localStorage.setItem("ds_logged", "true");
            window.location.href = "/";
        } else {
            shakeError(data.message);
        }
    } catch {
        shakeError("Server error.");
    } finally {
        loginBtn.classList.remove("loading");
    }
}

/* ---------- CORE UI LOGIC ---------- */
document.addEventListener("DOMContentLoaded", () => {
    const el = {
        fileInput: document.getElementById("file-input"),
        dropZone: document.getElementById("upload-container"),
        statusText: document.getElementById("main-status"),
        resultsGrid: document.getElementById("results-grid"),
        authBtn: document.getElementById("auth-trigger"),
        gauge: document.getElementById("gauge-progress"),
        percent: document.getElementById("gauge-percent"),
        scanActions: document.getElementById("scan-actions")
    };

    const MAX_FILE_SIZE_MB = 8;
    const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/tiff"];
    const timeline = document.getElementById("scan-timeline");

    let scanning = false;
    let lastResults = null;
    let lastImage = null;

    el.authBtn?.addEventListener("click", () => window.location.href = "/login");

    /* ---------- DRAG & DROP ---------- */
    el.dropZone?.addEventListener("click", () => el.fileInput.click());

    ["dragenter", "dragover"].forEach(evt => {
        el.dropZone?.addEventListener(evt, e => {
            e.preventDefault();
            el.dropZone.classList.add("drag-over");
        });
    });

    ["dragleave", "drop"].forEach(evt => {
        el.dropZone?.addEventListener(evt, e => {
            e.preventDefault();
            el.dropZone.classList.remove("drag-over");
        });
    });

    el.dropZone?.addEventListener("drop", e => {
        if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });

    el.fileInput?.addEventListener("change", () => {
        if (el.fileInput.files.length) handleFile(el.fileInput.files[0]);
    });

    /* ---------- SCANNING LOGIC ---------- */
    function handleFile(file) {
        if (!file || scanning) return;

        if (!ALLOWED_TYPES.includes(file.type)) {
            el.statusText.textContent = "Unsupported file type";
            el.statusText.style.color = "#ff4444";
            return;
        }

        if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
            el.statusText.textContent = "File too large (max 8MB)";
            el.statusText.style.color = "#ff4444";
            return;
        }

        scanning = true;

        showImagePreview(file);
        el.scanActions.classList.add("hidden");
        el.resultsGrid.innerHTML = "";
        resetGauge();

        el.dropZone.classList.add("is-scanning", "scan-wave");

        const phases = [
            "Extracting image features…",
            "Analyzing pixel consistency…",
            "Verifying metadata integrity…",
            "Running GAN detection models…"
        ];

        let i = 0;
        el.statusText.textContent = phases[0];
        timeline?.classList.remove("hidden");
        updateTimeline(0);

        const phaseTimer = setInterval(() => {
            i++;
            if (i < phases.length) {
                el.statusText.textContent = phases[i];
                updateTimeline(i);
            }
        }, 900);

        const maxPhaseTimeout = setTimeout(() => {
            clearInterval(phaseTimer);
            el.statusText.textContent = "Finalizing analysis…";
            updateTimeline(phases.length - 1);
        }, 4500);

        const formData = new FormData();
        formData.append("file", file);

        fetch("/analyze", { method: "POST", body: formData })
            .then(r => r.json())
            .then(data => {
                clearInterval(phaseTimer);
                clearTimeout(maxPhaseTimeout);

                el.dropZone.classList.remove("is-scanning", "scan-wave");
                if (!data.success) throw new Error();

                lastResults = data.results;
                lastImage = el.dropZone.querySelector("img")?.src;

                animateGaugeFromResults(data.results);
                displayResults(data.results);

                el.statusText.textContent = "Scan Complete";
                el.statusText.style.color = "#00ffa3";
                el.scanActions.classList.remove("hidden");
            })
            .catch(() => {
                clearInterval(phaseTimer);
                clearTimeout(maxPhaseTimeout);

                el.dropZone.classList.remove("is-scanning", "scan-wave");
                el.statusText.textContent = "Scan Failed";
                el.statusText.style.color = "#ff4444";
            })
            .finally(() => scanning = false);
    }

    function updateTimeline(step) {
        timeline?.querySelectorAll("li").forEach((li, idx) => {
            li.classList.remove("active", "done");
            if (idx < step) li.classList.add("done");
            if (idx === step) li.classList.add("active");
        });
    }

    function showImagePreview(file) {
        const reader = new FileReader();
        reader.onload = () => {
            el.dropZone.querySelector(".scanner-preview")?.remove();
            const wrap = document.createElement("div");
            wrap.className = "scanner-preview";
            const img = document.createElement("img");
            img.src = reader.result;
            wrap.appendChild(img);
            el.dropZone.appendChild(wrap);
        };
        reader.readAsDataURL(file);
    }

    function displayResults(results) {
        el.resultsGrid.innerHTML = "";
        results.forEach(r => {
            const div = document.createElement("div");
            div.className = "log-item";
            div.innerHTML = `<strong>${r.provider}</strong><span>${r.score}</span>`;
            el.resultsGrid.appendChild(div);
        });
    }

    function animateGaugeFromResults(results) {
        let total = 0, count = 0;
        results.forEach(r => {
            const m = String(r.score).match(/[\d.]+/);
            if (m) { total += parseFloat(m[0]); count++; }
        });
        const score = count ? Math.round(total / count) : 0;
        el.gauge.style.strokeDashoffset = 126 - (126 * score) / 100;
        let c = 0;
        const t = setInterval(() => {
            el.percent.textContent = c++;
            if (c > score) clearInterval(t);
        }, 16);
    }

    function resetGauge() {
        el.gauge.style.strokeDashoffset = 126;
        el.percent.textContent = "0";
    }

    function fullReset() {
        el.dropZone.querySelector(".scanner-preview")?.remove();
        el.fileInput.value = "";
        el.resultsGrid.innerHTML = "";
        el.scanActions.classList.add("hidden");
        el.dropZone.classList.remove("is-scanning", "scan-wave", "drag-over");
        el.statusText.textContent = "Guest Mode Active";
        el.statusText.style.color = "#ffffff";
        timeline?.classList.add("hidden");
        timeline?.querySelectorAll("li").forEach(li => li.classList.remove("active", "done"));
        resetGauge();
        scanning = false;
    }

    el.scanActions.addEventListener("click", e => {
        const action = e.target.closest("button")?.dataset.action;
        if (action === "back") fullReset();
        if (action === "confirm") setTimeout(fullReset, 600);
        if (action === "save") {
            if (localStorage.getItem("ds_logged") !== "true") {
                alert("Login required to save results");
                return;
            }
            const history = JSON.parse(localStorage.getItem("ds_history") || "[]");
            history.unshift({ image: lastImage, results: lastResults, time: new Date().toISOString() });
            localStorage.setItem("ds_history", JSON.stringify(history));
            el.statusText.textContent = "Result Saved";
        }
    });
});
