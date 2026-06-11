import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from "fs";
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

// 本周一到周日
function weekRange() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun
  const monOffset = day === 0 ? 6 : day - 1;
  const mon = new Date(now);
  mon.setDate(now.getDate() - monOffset);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  const fmt = d => d.toISOString().split("T")[0];
  return { start: fmt(mon), end: fmt(sun), label: `${mon.getFullYear()}年第${Math.ceil((mon.getDate() + (new Date(mon.getFullYear(), mon.getMonth(), 1).getDay() || 7) - 1) / 7)}周` };
}

function main() {
  console.log("📋 生成周度要闻...\n");

  const { start, end, label } = weekRange();
  console.log(`  周期: ${start} ~ ${end} (${label})`);

  // 读取本周归档
  const archiveDir = join(__dirname, "archive");
  if (!existsSync(archiveDir)) { console.log("  ⚠️ 无归档数据"); return; }

  const files = readdirSync(archiveDir).filter(f => f.endsWith(".json"));
  let weekItems = [];
  for (const f of files) {
    const d = f.replace(".json", "");
    if (d >= start && d <= end) {
      try {
        const data = JSON.parse(readFileSync(join(archiveDir, f), "utf-8"));
        for (const item of data.items || []) {
          weekItems.push({ ...item, archivedDate: d });
        }
      } catch {}
    }
  }

  console.log(`  本周共 ${weekItems.length} 条新闻`);

  if (weekItems.length === 0) {
    console.log("  ⚠️ 本周无数据");
    return;
  }

  // 保存原始列表
  const output = {
    period: `${start}/${end}`,
    label,
    generated: new Date().toISOString(),
    total: weekItems.length,
    items: weekItems,
    overview: "",
  };

  // 写文件（先写无 overview 版本，后面异步补）
  const outPath = join(__dirname, "summary-weekly.json");
  writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");

  // 如果 API 可用，生成概述
  if (DEEPSEEK_KEY) {
    generateOverview(weekItems).then(overview => {
      output.overview = overview;
      writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");
      console.log(`✅ summary-weekly.json (${weekItems.length}条 + 综述)`);
    }).catch(err => {
      console.log(`  ⚠️ 综述生成失败: ${err.message}`);
      console.log(`✅ summary-weekly.json (${weekItems.length}条, 无综述)`);
    });
  } else {
    console.log(`✅ summary-weekly.json (${weekItems.length}条, 无API Key)`);
  }
}

async function generateOverview(items) {
  const cats = { "ai-progress": "AI进展", "ai-regulation": "AI监管", "legal-ai": "法律AI" };
  const byCat = {};
  items.forEach(i => { const c = cats[i.category] || i.category; if (!byCat[c]) byCat[c] = []; byCat[c].push(i.title); });

  const summary = Object.entries(byCat).map(([cat, titles]) =>
    `${cat}: ${titles.slice(0, 6).map((t, idx) => `${idx + 1}. ${t}`).join("\n")}`
  ).join("\n\n");

  const prompt = `你是一个AI行业资深编辑。以下是本周（共${items.length}条）AI合规/法律AI领域的重要新闻摘要。

请写一段300-400字的"本周要闻综述"，包括：
1. 本周三大领域（AI重大进展、AI监管动态、法律AI）的整体态势
2. 各领域最重要的1-2件事
3. 下周值得关注的趋势

不要emoji，不要markdown。

新闻列表：
${summary}`;

  const resp = await askDeepSeek([{ role: "user", content: prompt }]);
  return resp.trim();
}

main();
