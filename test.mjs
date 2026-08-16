// Smoke test: POST a payload like the /druglist/go page would send.
const BASE = process.env.TEST_BASE || "http://localhost:8787";

const payload = {
  slug: "dolo-650-tablet",
  name: "Dolo 650 Tablet",
  composition: "Paracetamol (650mg)",
  strength: "650mg",
  form: "tablet",
  manufacturer: "Micro Labs Ltd",
};

const res = await fetch(`${BASE}/availability`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
const body = await res.json();
console.log("status:", res.status);
console.log("response:", JSON.stringify(body, null, 2));

if (body.ok !== true || !body.url) {
  console.error("FAIL: expected ok:true with a url");
  process.exit(1);
}
console.log("PASS");