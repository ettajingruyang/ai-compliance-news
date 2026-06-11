import { writeFileSync, existsSync, readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";

async function askDeepSeek(messages) {
  if (!DEEPSEEK_KEY) throw new Error("No API key");
  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${DEEPSEEK_KEY}` },
    body: JSON.stringify({ model: "deepseek-chat", messages, temperature: 0.7, max_tokens: 4096 }),
  });
  if (!res.ok) throw new Error(`DeepSeek API ${res.status}: ${await res.text()}`);
  return (await res.json()).choices[0].message.content;
}

function monthlyRange() {
  const now = new Date();
  // 上月
  const m = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
  const y = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const start = `${y}-${String(m + 1).padStart(2, "0")}-01`;
  const lastDay = new Date(y, m + 1, 0).getDate();
  const end = `${y}-${String(m + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  const months = ["1月","2月","3月","4月","5月","6月","7月","8月","9月","10月","11月","12月"];
  return { start, end, label: `${y}年${months[m]}` };
}

async function main() {
  console.log("📋 生成月度要闻...\n");

  const { start, end, label } = monthlyRange();
  console.log(`  周期: ${start} ~ ${end} (${label})`);

  const archiveDir = join(__dirname, "archive");
  if (!existsSync(archiveDir)) { console.log("  ⚠️ 无归档数据"); return; }

  const files = readdirSync(archiveDir).filter(f => f.endsWith(".json"));
  let monthItems = [];
  for (const f of files) {
    const d = f.replace(".json", "");
    if (d >= start && d <= end) {
      try {
        const data = JSON.parse(readFileSync(join(archiveDir, f), "utf-8"));
        for (const item of data.items || []) {
          monthItems.push({ ...item, archivedDate: d });
        }
      } catch {}
    }
  }

  console.log(`  本月共 ${monthItems.length} 条新闻`);

  if (monthItems.length === 0) {
    console.log("  ⚠️ 本月无数据");
    return;
  }

  const output = {
    period: `${start}/${end}`,
    label,
    generated: new Date().toISOString(),
    total: monthItems.length,
    items: monthItems,
    overview: "",
  };

  const outPath = join(__dirname, "summary-monthly.json");
  writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");

  if (DEEPSEEK_KEY) {
    try {
      const overview = await generateMonthlyOverview(monthItems, label);
      output.overview = overview;
      writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");
      console.log(`✅ summary-monthly.json (${monthItems.length}条 + 综述)`);
    } catch (err) {
      console.log(`  ⚠️ 综述生成失败: ${err.message}`);
      console.log(`✅ summary-monthly.json (${monthItems.length}条, 无综述)`);
    }
  } else {
    console.log(`✅ summary-monthly.json (${monthItems.length}条)`);
  }
}

async function generateMonthlyOverview(items, label) {
  const cats = { "ai-progress": "AI进展", "ai-regulation": "AI监管", "legal-ai": "法律AI" };
  const byCat = {};
  items.forEach(i => { const c = cats[i.category] || i.category; if (!byCat[c]) byCat[c] = []; byCat[c].push(i.title); });

  const summary = Object.entries(byCat).map(([cat, titles]) =>
    `${cat}: ${titles.slice(0, 10).map((t, idx) => `${idx + 1}. ${t}`).join("\n")}`
  ).join("\n\n");

  const prompt = `你是一个AI行业资深编辑。以下是${label}（共${items.length}条）AI合规/法律AI领域的重要新闻摘要。

请写一段500-600字的"${label}月度要闻综述"，包括：
1. 本月三大领域的整体态势和主要趋势
2. 各领域最重要的2-3件事
3. 下月值得关注的方向

不要emoji，不要markdown。

新闻列表：
${summary}`;

  const resp = await askDeepSeek([{ role: "user", content: prompt }]);
  return resp.trim();
}

main().catch(err => { console.error("❌", err); process.exit(1); });
