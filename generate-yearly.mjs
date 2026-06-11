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

function yearlyRange() {
  const now = new Date();
  const y = now.getFullYear() - 1;
  return { start: `${y}-01-01`, end: `${y}-12-31`, label: `${y}年` };
}

async function main() {
  console.log("📋 生成年度回顾...\n");

  const { start, end, label } = yearlyRange();
  console.log(`  周期: ${start} ~ ${end} (${label})`);

  const archiveDir = join(__dirname, "archive");
  if (!existsSync(archiveDir)) { console.log("  ⚠️ 无归档数据"); return; }

  const files = readdirSync(archiveDir).filter(f => f.endsWith(".json"));
  let yearItems = [];
  for (const f of files) {
    const d = f.replace(".json", "");
    if (d >= start && d <= end) {
      try {
        const data = JSON.parse(readFileSync(join(archiveDir, f), "utf-8"));
        for (const item of data.items || []) {
          yearItems.push({ ...item, archivedDate: d });
        }
      } catch {}
    }
  }

  console.log(`  全年共 ${yearItems.length} 条新闻（跨 ${new Set(yearItems.map(i => i.archivedDate)).size} 天）`);

  if (yearItems.length === 0) { console.log("  ⚠️ 无数据"); return; }

  const output = {
    period: `${start}/${end}`,
    label,
    generated: new Date().toISOString(),
    total: yearItems.length,
    items: yearItems,
    overview: "",
  };

  const outPath = join(__dirname, "summary-yearly.json");
  writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");

  if (DEEPSEEK_KEY) {
    try {
      const overview = await generateYearlyOverview(yearItems, label);
      output.overview = overview;
      writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");
      console.log(`✅ summary-yearly.json (${yearItems.length}条 + 综述)`);
    } catch (err) {
      console.log(`  ⚠️ 综述生成失败: ${err.message}`);
      console.log(`✅ summary-yearly.json (${yearItems.length}条, 无综述)`);
    }
  } else {
    console.log(`✅ summary-yearly.json (${yearItems.length}条)`);
  }
}

async function generateYearlyOverview(items, label) {
  // 按季度分组
  const byQuarter = {};
  items.forEach(i => {
    const m = parseInt(i.archivedDate?.split("-")[1] || "1");
    const q = `Q${Math.ceil(m / 3)}`;
    if (!byQuarter[q]) byQuarter[q] = [];
    byQuarter[q].push(i.title);
  });

  const quarterly = Object.entries(byQuarter)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([q, titles]) => `${q}: ${titles.slice(0, 8).map((t, idx) => `${idx + 1}. ${t}`).join("\n")}`)
    .join("\n\n");

  const prompt = `你是一个AI行业资深编辑。以下是${label}全年（共${items.length}条）AI合规/法律AI领域的新闻摘要，按季度整理。

请写一段600-800字的"${label}年度回顾"，包括：
1. 全年AI行业的总体态势，分季度描述演进脉络
2. 年度最重大的5-8件事（跨领域）
3. 对下一年趋势的展望

不要emoji，不要markdown。

各季度新闻：
${quarterly}`;

  const resp = await askDeepSeek([{ role: "user", content: prompt }]);
  return resp.trim();
}

main().catch(err => { console.error("❌", err); process.exit(1); });
