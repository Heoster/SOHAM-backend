import { createRequire } from "module";
const require = createRequire(import.meta.url);
const dotenv = require("dotenv");
dotenv.config({ path: "server/.env" });

await new Promise(r => setTimeout(r, 2000));

async function test(modelId) {
  const res = await fetch("https://api.cerebras.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.CEREBRAS_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "Say OK" }], max_tokens: 10 })
  });
  const d = await res.json();
  const ok = res.ok && d.choices?.[0]?.message?.content;
  console.log(ok ? "PASS" : "FAIL", modelId, ok ? "" : (d.error?.message || JSON.stringify(d)).slice(0,100));
}

await Promise.all([
  test("qwen-3-235b-a22b-instruct-2507"),
  test("gpt-oss-120b"),
  test("zai-glm-4.7"),
]);
