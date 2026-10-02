// This file's name is special: Netlify automatically runs it every time
// ANY form on the site is submitted. You don't call this yourself.
//
// It emails exercises@plan-proof.com (via Resend) with the clean summary the
// site builds for each form. For the "plan-review" form it also downloads the
// uploaded plan document and attaches the actual file to the email, so you
// don't depend on the Netlify file link opening in your email app.
//
// It also saves every submission into Supabase (clients + submissions tables)
// so leads can be tracked beyond the Netlify Forms inbox and this email. This
// uses the website's public, insert-only key (SUPABASE_PUBLISHABLE_KEY): it
// can add new rows but cannot read, change, or delete anything (enforced by
// Row Level Security policies on the database, not by this code). If
// Supabase is slow or down, the submission still succeeds and the email
// still sends — saving to Supabase never blocks the person submitting the form.

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // site limits uploads to 8 MB

// "Fire (main), Flood, Cyberattack" -> ["Fire", "Flood", "Cyberattack"]
function parseRiskConcerns(riskStr) {
  if (!riskStr || typeof riskStr !== "string") return [null, null, null];
  const parts = riskStr.split(",").map((s) => s.trim().replace(/\s*\(main\)\s*$/i, "")).filter(Boolean);
  return [parts[0] || null, parts[1] || null, parts[2] || null];
}

async function supabaseInsert(table, rows, { returnRepresentation = false } = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Supabase env vars not set");
  const res = await fetch(`${url}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: returnRepresentation ? "return=representation" : "return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    throw new Error(`Supabase insert into ${table} failed: HTTP ${res.status} ${await res.text()}`);
  }
  return returnRepresentation ? res.json() : null;
}

async function saveToSupabase(formName, data, humanFields, summary) {
  const [riskMain, risk2, risk3] = parseRiskConcerns(data.risk);
  const clientRows = await supabaseInsert(
    "clients",
    [
      {
        company_name: data.organization || humanFields.Organization || humanFields.organization || null,
        contact_name: data.name || null,
        email: data.email || null,
        phone: data.mobile || null,
      },
    ],
    { returnRepresentation: true }
  );
  const clientId = clientRows && clientRows[0] && clientRows[0].id;
  await supabaseInsert("submissions", [
    {
      client_id: clientId || null,
      risk_concern_1: riskMain,
      risk_concern_2: risk2,
      risk_concern_3: risk3,
      key_operations: data.operations || null,
      notes: `Form: ${formName}\n\n${summary}`,
    },
  ]);
}

// Netlify has delivered uploaded files in two shapes over time:
//   "https://...file.pdf"                                  (plain URL string)
//   { url: "https://...", filename: "...", type: "...", size: 123 }  (object)
// Accept either, and return { url, filename } or null.
function readFileField(value) {
  if (!value) return null;
  if (typeof value === "string") {
    if (!value.startsWith("http")) return null;
    const lastPart = decodeURIComponent(value.split("?")[0].split("/").pop() || "plan-document");
    return { url: value, filename: lastPart };
  }
  if (typeof value === "object" && typeof value.url === "string") {
    return { url: value.url, filename: value.filename || value.name || "plan-document" };
  }
  return null;
}

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const payload = body.payload || {};
    const formName = payload.form_name;
    const data = payload.data || {};
    const humanFields = payload.human_fields || {};

    const summary = data.formatted_summary || "(No summary available)";
    const lines = [`New submission: ${formName}`, `Received: ${new Date().toLocaleString("en-GB", { timeZone: "Asia/Dubai" })} (UAE time)`, "", summary];

    // ---- Save to Supabase (best-effort; never blocks the email below) ----
    try {
      await saveToSupabase(formName, data, humanFields, summary);
    } catch (err) {
      console.error("Supabase save error (non-fatal):", err.message);
    }

    const attachments = [];

    // ---- Plan document (plan-review form) ----
    const rawFile = data.plan_document;
    if (rawFile !== undefined) {
      // Logged so the shape can be checked in Netlify > Logs > Functions if needed.
      console.log("plan_document field type:", typeof rawFile, typeof rawFile === "object" ? Object.keys(rawFile) : "");
    }
    const file = readFileField(rawFile);

    if (file) {
      let attached = false;
      try {
        const fileRes = await fetch(file.url);
        if (fileRes.ok) {
          const buf = Buffer.from(await fileRes.arrayBuffer());
          if (buf.length > 0 && buf.length <= MAX_ATTACHMENT_BYTES) {
            attachments.push({ filename: file.filename, content: buf.toString("base64") });
            attached = true;
          } else {
            console.log("plan_document size not attachable:", buf.length);
          }
        } else {
          console.log("plan_document download failed: HTTP", fileRes.status);
        }
      } catch (err) {
        console.log("plan_document download error:", err.message);
      }

      lines.push("");
      if (attached) {
        lines.push(`Attached plan document: ${file.filename} (see attachment)`);
      } else {
        lines.push("The plan document could not be attached automatically.");
        lines.push(`Try this link: ${file.url}`);
        lines.push("If it doesn't open, download it from Netlify > Forms > plan-review > this submission.");
      }
    } else if (formName === "plan-review") {
      lines.push("");
      lines.push("No plan document link was received with this submission.");
      lines.push("Check Netlify > Forms > plan-review > this submission for the uploaded file.");
    }

    const textSummary = lines.join("\n");
    attachments.push({
      filename: `${formName}-submission.txt`,
      content: Buffer.from(textSummary).toString("base64"),
    });

    // Sender addresses, tried in order. The first is PlanProof's own verified
    // sending domain (set up in Resend as notify.plan-proof.com). If Resend ever
    // refuses it (e.g. the domain isn't verified yet), we fall back to Resend's
    // shared address so the email still arrives.
    const senders = [
      process.env.RESEND_FROM_ADDRESS,
      "PlanProof <alerts@notify.plan-proof.com>",
      "onboarding@resend.dev",
    ].filter((v, i, arr) => v && arr.indexOf(v) === i);

    const subject = `New ${formName} submission \u2014 ${data.organization || humanFields.Organization || humanFields.organization || "PlanProof"}`;

    let sentOk = false;
    let lastError = "";
    for (const from of senders) {
      if (sentOk) break;
      const emailBody = JSON.stringify({ from, to: ["exercises@plan-proof.com"], subject, text: textSummary, attachments });
      // Up to 3 tries per sender so a brief Resend hiccup doesn't lose the email.
      for (let attempt = 1; attempt <= 3 && !sentOk; attempt++) {
        if (attempt > 1) await new Promise((r) => setTimeout(r, 1500 * (attempt - 1)));
        try {
          const resendResponse = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: emailBody,
          });
          if (resendResponse.ok) {
            sentOk = true;
          } else {
            lastError = `HTTP ${resendResponse.status} from ${from}: ${await resendResponse.text()}`;
            console.log("Resend refused:", lastError);
            // A 4xx (other than rate-limit) means this sender won't work -> try the next sender.
            if (resendResponse.status >= 400 && resendResponse.status < 500 && resendResponse.status !== 429) break;
          }
        } catch (err) {
          lastError = err.message;
        }
      }
    }

    if (!sentOk) {
      console.error("Resend API error:", lastError);
      return { statusCode: 500, body: "Email failed to send" };
    }

    return { statusCode: 200, body: "OK" };
  } catch (err) {
    console.error("submission-created function error:", err);
    return { statusCode: 500, body: "Error processing submission" };
  }
};

