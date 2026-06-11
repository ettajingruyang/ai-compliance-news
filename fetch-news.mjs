import Parser from "rss-parser";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// 配置
// ============================================================

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";

const parser = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "AI-Compliance-News-Aggregator/1.0" },
  customFields: { item: ["source"] },
});

// ––– 信息源 –––

function gNews(q) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
}

const sources = {
  googleNews: [
    // AI进展 (中文)
    { query: '("大模型" OR "AI模型" OR "人工智能") AND (发布 OR 开源 OR 上线 OR 推出 OR 突破)', cat: "ai-progress" },
    { query: '(OpenAI OR Anthropic OR 百度 OR 阿里 OR 华为 OR DeepSeek OR 智谱 OR Kimi OR 字节) AND (发布 OR 推出 OR 开源 OR 融资 OR 上市)', cat: "ai-progress" },
    // AI进展 (英文)
    { query: '("AI model" OR "GPT" OR "foundation model" OR "LLM") AND (release OR launch OR breakthrough OR announce) -regulation -law -ban -executive -order', cat: "ai-progress" },
    { query: '(OpenAI OR Anthropic OR "Google DeepMind" OR Meta OR DeepSeek OR xAI) AND (release OR launch OR funding OR IPO OR model) -regulation -lawsuit -ban', cat: "ai-progress" },
    // AI 监管 (中文)
    { query: '("AI监管" OR "人工智能治理" OR "AI立法" OR "算法备案" OR "数据合规")', cat: "ai-regulation" },
    // AI 监管 (英文)
    { query: '("EU AI Act" OR "AI regulation" OR "AI legislation" OR "AI Act") AND (law OR policy OR enforcement OR compliance)', cat: "ai-regulation" },
    { query: '("AI governance" OR "AI executive order" OR "FTC AI" OR "AI liability" OR "AI fine" OR "AI lawsuit")', cat: "ai-regulation" },
    // 法律AI (中文)
    { query: '("法律AI" OR "AI法律" OR "智能司法" OR "合规科技" OR "AI律师")', cat: "legal-ai" },
    // 法律AI (英文)
    { query: '("legal AI" OR "AI lawyer" OR "legal tech" OR "AI legal" OR "AI contract") AND (AI OR platform OR startup OR funding OR tool)', cat: "legal-ai" },
  ],
  rss: [
    // 境外
    { url: "https://iapp.org/news/feed/", cat: "ai-regulation" },
    { url: "https://techcrunch.com/category/artificial-intelligence/feed/", cat: "ai-progress" },
    { url: "https://www.technologyreview.com/topic/artificial-intelligence/feed/", cat: "ai-progress" },
    { url: "https://www.artificiallawyer.com/feed", cat: "legal-ai" },
    { url: "https://feeds.feedblitz.com/abajournal/topstories", cat: "legal-ai" },
    { url: "https://www.theverge.com/ai-artificial-intelligence/rss/index.xml", cat: "ai-progress" },
    { url: "https://venturebeat.com/category/ai/feed/", cat: "ai-progress" },
    // 中国
    { url: "https://www.jiqizhixin.com/rss", cat: "ai-progress" },
    { url: "https://rsshub.app/36kr/motif/327403059714547", cat: "ai-progress" },
    { url: "https://rsshub.app/thepaper/feature/27203", cat: "ai-regulation" },
    { url: "https://rsshub.app/xinhua/ai", cat: "ai-regulation" },
  ],
  hn: [
    { query: "AI regulation", cat: "ai-regulation" },
    { query: "EU AI Act", cat: "ai-regulation" },
    { query: "legal AI", cat: "legal-ai" },
    { query: "AI copyright OR AI law", cat: "legal-ai" },
    { query: "AI model release", cat: "ai-progress" },
    { query: "OpenAI OR Anthropic OR DeepMind OR DeepSeek", cat: "ai-progress" },
  ],
};

// ============================================================
// 工具函数
// ============================================================

function clean(s) {
  if (!s) return "";
  return s.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ").trim().substring(0, 300);
}

function extractSource(title, srcField) {
  if (srcField) {
    if (typeof srcField === "string") return srcField;
    const v = srcField._ || srcField.$text || srcField.text || srcField.content;
    if (v) return v;
  }
  const m = title.match(/\s[-–—]\s([^\s].+)$/);
  if (m && m[1].length < 60 && !m[1].includes(" - ")) return m[1];
  return "未知来源";
}

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").substring(0, 80);
}

function todayStr() {
  return new Date().toISOString().split("T")[0];
}

function scoreByKeywords(title) {
  const t = title.toLowerCase();
  let score = 0;
  if (/eu ai act|european (union|commission|parliament)/.test(t)) score += 5;
  if (/supreme court|federal court|landmark|ruling/.test(t)) score += 5;
  if (/ftc|sec|doj|department of justice/.test(t)) score += 4;
  if (/white house|executive order|president/.test(t)) score += 4;
  if (/china|chinese|beijing|中国|算法/.test(t)) score += 4;
  if (/openai|gpt-5|gpt-4|chatgpt/.test(t)) score += 5;
  if (/anthropic|claude/.test(t)) score += 4;
  if (/google deepmind|gemini|alphafold/.test(t)) score += 5;
  if (/breakthrough|milestone|revolutionary|record/.test(t)) score += 3;
  if (/fine|penalt|billion|million.*(euro|dollar)/.test(t)) score += 4;
  if (/ban|prohibit|restrict|illegal/.test(t)) score += 3;
  if (/investigation|probe|enforcement|raid/.test(t)) score += 3;
  if (/releas|launch|announce|unveil|introduce/.test(t)) score += 2;
  if (/law firm|legal tech|legal AI|AI lawyer|court.*AI/.test(t)) score += 4;
  if (/copyright|intellectual property|patent/.test(t)) score += 3;
  if (title.length > 30 && title.length < 150) score += 1;
  return score;
}

// ============================================================
// 抓取函数
// ============================================================

async function fetchGoogleNews({ query, cat }) {
  try {
    const feed = await parser.parseURL(gNews(query));
    return feed.items.map(item => ({
      id: "g-" + slug(item.link || item.title),
      title: item.title?.trim() || "",
      url: item.link || "",
      source: extractSource(item.title, item.source),
      summary: clean(item.contentSnippet || item.content || ""),
      date: item.pubDate ? new Date(item.pubDate).toISOString().split("T")[0] : "",
      category: cat,
      score: scoreByKeywords(item.title || ""),
    }));
  } catch { return []; }
}

async function fetchRSS({ url, cat }) {
  try {
    const feed = await parser.parseURL(url);
    const host = new URL(url).hostname.replace(/^www\./, "");
    return feed.items.map(item => ({
      id: "r-" + slug(item.link || item.title),
      title: item.title?.trim() || "",
      url: item.link || "",
      source: host,
      summary: clean(item.contentSnippet || item.content || item.summary || ""),
      date: item.pubDate ? new Date(item.pubDate).toISOString().split("T")[0] : item.isoDate?.split("T")[0] || "",
      category: cat,
      score: scoreByKeywords(item.title || ""),
    }));
  } catch { return []; }
}

async function fetchHN({ query, cat }) {
  try {
    const u = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=20`;
    const res = await fetch(u, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];
    const data = await res.json();
    return data.hits.map(h => ({
      id: "hn-" + h.objectID,
      title: h.title?.trim() || "",
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      source: "Hacker News",
      summary: h.story_text ? clean(h.story_text).substring(0, 200) : `💬 ${h.num_comments || 0} 条讨论 · ⭐ ${h.points || 0} 分`,
      date: h.created_at ? h.created_at.split("T")[0] : "",
      category: cat,
      score: scoreByKeywords(h.title || "") + Math.min((h.points || 0) / 50, 5),
    }));
  } catch { return []; }
}

// ============================================================
// DeepSeek — 精选 + 分析 + 翻译
// ============================================================

async function askDeepSeek(messages) {
  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${DEEPSEEK_KEY}` },
    body: JSON.stringify({ model: "deepseek-chat", messages, temperature: 0.7, max_tokens: 4096 }),
  });
  if (!res.ok) throw new Error(`DeepSeek API ${res.status}: ${await res.text()}`);
  return (await res.json()).choices[0].message.content;
}

function hasChinese(text) {
  return /[一-鿿]/.test(text || "");
}

async function translateToChinese(items) {
  const needTranslate = items
    .map((item, i) => ({ item, i, need: !hasChinese(item.title) }))
    .filter(x => x.need);

  if (needTranslate.length === 0) {
    console.log("    全部已是中文，无需翻译");
    return;
  }

  const list = needTranslate.map(({ item }, idx) =>
    `[${idx + 1}] 标题: ${item.title}\n    摘要: ${item.summary?.substring(0, 200) || "无"}`
  ).join("\n\n");

  const prompt = `请将以下英语新闻翻译成中文，保持专业、准确、简洁。

对于每条新闻，请返回：标题翻译、摘要翻译（如摘要为空则写"无"）。

请返回JSON数组，每个元素包含：序号(index, 数字)、标题翻译(title_cn, 中文)、摘要翻译(summary_cn, 中文)。
只返回JSON，不要其他文字。

新闻列表：
${list}`;

  try {
    const resp = await askDeepSeek([{ role: "user", content: prompt }]);
    const json = JSON.parse(resp.match(/\[[\s\S]*\]/)?.[0] || "[]");
    json.forEach(j => {
      const entry = needTranslate[j.index - 1];
      if (entry) {
        if (j.title_cn) entry.item.title = j.title_cn;
        if (j.summary_cn && j.summary_cn !== "无") entry.item.summary = j.summary_cn;
      }
    });
    console.log(`    翻译完成: ${json.length} 条`);
  } catch (err) {
    console.log(`    ⚠️ 翻译失败: ${err.message}`);
  }
}

async function curateWithAI(items, cat, catName) {
  if (items.length <= 5) return items;

  const candidates = items.sort((a, b) => b.score - a.score).slice(0, 30);

  const list = candidates.map((item, i) =>
    `[${i + 1}] ${item.title} | 来源: ${item.source} | 日期: ${item.date}\n  摘要: ${item.summary.substring(0, 150)}`
  ).join("\n\n");

  const categoryDefinitions = {
    "ai-progress": "AI行业重大进展：聚焦AI公司产品发布（如新模型、新功能上线）、技术突破、重大融资/IPO、行业并购、AI基础设施重大建设。**注意：不包括政策法规、行政处罚、诉讼案件、版权纠纷、监管动态**——这些属于AI监管。",
    "ai-regulation": "AI监管动态：聚焦各国AI立法进程、行政命令、监管机构执法行动、AI相关诉讼判决、数据隐私处罚、AI安全合规要求、反垄断调查。**注意：不包括AI公司产品发布、技术突破、融资消息**——这些属于AI进展。",
    "legal-ai": "法律AI行业动态：聚焦法律科技公司的产品发布、融资、合作、并购，AI在法律服务中的应用（合同审查、法律研究、诉讼预测等），法律行业对AI的采用趋势。**注意：不包括政府AI立法监管政策、AI版权诉讼判决**——这些属于AI监管。",
  };

  const def = categoryDefinitions[cat] || "";

  const prompt = `你是一个AI行业的专业编辑。请从以下候选新闻中，为"${catName}"栏目挑选最重要的5条新闻。

⚠️ 栏目定义（严格遵守）：
${def}

挑选标准：
- 优先选择对该栏目领域有重大影响的新闻
- 略过纯营销内容、重复报道、无实质信息的文章
- 如果候选新闻中有明显不属于本栏目的（属于另外两个栏目），坚决排除

请返回JSON数组，每个元素包含：选中的序号(index, 数字)、选择理由(reason, 中文, 15字以内)。
只返回JSON，不要其他文字。

候选新闻：
${list}`;

  try {
    const resp = await askDeepSeek([{ role: "user", content: prompt }]);
    const json = JSON.parse(resp.match(/\[[\s\S]*\]/)?.[0] || "[]");
    const indices = json.map(j => j.index - 1).filter(i => i >= 0 && i < candidates.length);
    return indices.map(i => ({ ...candidates[i], reason: json.find(j => j.index === i + 1)?.reason || "" }));
  } catch (err) {
    console.log(`    ⚠️ AI 精选失败(${catName}): ${err.message}，回退到关键词评分`);
    return candidates.slice(0, 5);
  }
}

async function analyzeCategoryItems(items, catName) {
  if (items.length === 0) return {};

  const catContext = {
    "AI重大进展": "这些新闻属于AI行业重大进展栏目。请从技术/产品/商业角度解读，不要过度关注监管合规层面。",
    "AI监管动态": "这些新闻属于AI监管动态栏目。请从政策/法律/合规角度解读，重点分析监管影响和行业合规启示。",
    "法律AI": "这些新闻属于法律AI行业动态栏目。请从法律科技行业角度解读，重点分析对法律服务市场和法律行业的影响。",
  };

  const list = items.map((item, i) =>
    `[${i + 1}] 标题: ${item.title}\n    来源: ${item.source}\n    日期: ${item.date}\n    原始摘要: ${item.summary?.substring(0, 300) || "无"}`
  ).join("\n\n");

  const prompt = `你是一个AI行业的资深分析师。请为以下"${catName}"栏目的${items.length}条新闻分别撰写详细解读。

${catContext[catName] || ""}

每条解读要求（350-500字中文），按以下结构组织：
【事件概述】2-3句话介绍核心事件
【关键信息】2-3个要点（用 - 开头）
【行业影响】短期和长期影响分析

格式示例：
【事件概述】xxx公司于近日发布了xxx产品，这是xxx领域的一次重大突破……
【关键信息】
- 要点一
- 要点二
【行业影响】该事件标志着xxx，短期内xxx，长期来看xxx……

注意：不要markdown标题，不要附原文链接，不要emoji。

请返回JSON数组：序号(index)、解读(analysis)。只返回JSON。`;

  try {
    const resp = await askDeepSeek([{ role: "user", content: prompt }]);
    let jsonStr = resp.match(/\[[\s\S]*\]/)?.[0];
    if (!jsonStr) return await analyzeOneByOne(items);
    jsonStr = jsonStr.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "");
    let json;
    try { json = JSON.parse(jsonStr); } catch { return await analyzeOneByOne(items); }
    const map = {};
    json.forEach(j => { if (j.index != null) map[j.index] = j.analysis || ""; });
    return map;
  } catch (err) {
    console.log(`    ⚠️ 批量分析(${catName}): ${err.message}`);
    return {};
  }
}

async function analyzeOneByOne(items) {
  const map = {};
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const prompt = `请为以下这条新闻撰写详细解读（350-500字中文）。

【事件概述】2-3句话核心事件
【关键信息】2-3个要点（用 - 开头）
【行业影响】短期和长期影响

新闻：${item.title}
来源：${item.source}
摘要：${item.summary?.substring(0, 300) || "无"}

不要markdown，不要链接，不要emoji。`;

    try {
      const text = await askDeepSeek([{ role: "user", content: prompt }]);
      map[i + 1] = text.trim();
    } catch { map[i + 1] = ""; }
  }
  return map;
}

// ============================================================
// 归档 & all.json 累积
// ============================================================

function updateArchive(date, items) {
  const archiveDir = join(__dirname, "archive");
  if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });

  const archivePath = join(archiveDir, `${date}.json`);
  const record = {
    date,
    generated: new Date().toISOString(),
    total: items.length,
    items,
  };
  writeFileSync(archivePath, JSON.stringify(record, null, 2), "utf-8");
  console.log(`📁 归档: archive/${date}.json`);
}

function updateAllJson(date, items) {
  const allPath = join(__dirname, "all.json");

  let existing = [];
  if (existsSync(allPath)) {
    try { existing = JSON.parse(readFileSync(allPath, "utf-8")).items || []; } catch { existing = []; }
  }

  const existingUrls = new Set(existing.map(i => i.url));

  // 不重复追加
  const newItems = items.filter(i => !existingUrls.has(i.url));
  const merged = [...existing, ...newItems];

  // 只保留12个月
  const cutoff = new Date(Date.now() - 365 * 86400000).toISOString().split("T")[0];
  const trimmed = merged.filter(i => i.date >= cutoff);

  const output = {
    updated: new Date().toISOString(),
    total: trimmed.length,
    items: trimmed,
  };

  writeFileSync(allPath, JSON.stringify(output, null, 2), "utf-8");
  console.log(`📋 all.json: ${trimmed.length} 条 (新增 ${newItems.length})`);
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  console.log("🚀 AI 合规资讯聚合器\n");

  const useAI = !!DEEPSEEK_KEY;
  if (!useAI) {
    console.log("⚠️  未设置 DEEPSEEK_API_KEY 环境变量，将使用关键词评分排序（跳过AI精选）\n");
  }

  const date = todayStr();

  // 1. 抓取
  const tasks = [
    ...sources.googleNews.map(q => fetchGoogleNews(q)),
    ...sources.rss.map(r => fetchRSS(r)),
    ...sources.hn.map(h => fetchHN(h)),
  ];
  console.log(`📡 正在抓取 ${tasks.length} 个信息源...\n`);
  const results = await Promise.all(tasks);
  let all = results.flat();
  console.log(`📊 原始抓取: ${all.length} 条`);

  // 2. 去重
  const seen = new Set();
  all = all.filter(item => {
    const k = item.url || item.id;
    if (!k || seen.has(k)) return false;
    if (!item.title || !item.url) return false;
    seen.add(k);
    return true;
  });
  console.log(`📊 去重后: ${all.length} 条`);

  // 3. 近7天
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
  all = all.filter(item => item.date >= cutoff);
  console.log(`📊 近7天: ${all.length} 条`);

  // 4. 精选 + 分析
  const catNames = { "ai-progress": "AI重大进展", "ai-regulation": "AI监管动态", "legal-ai": "法律AI" };
  const PER_CATEGORY = 5;

  const aiLabel = useAI ? "🤖 DeepSeek 精选 + 分析" : "📊 关键词评分排序";
  console.log(`\n${aiLabel}\n`);

  let allCurated = [];

  for (const [cat, name] of Object.entries(catNames)) {
    const items = all.filter(i => i.category === cat);
    let selected;

    if (useAI && items.length > PER_CATEGORY) {
      selected = await curateWithAI(items, cat, name);
    } else {
      selected = items.sort((a, b) => b.score - a.score).slice(0, PER_CATEGORY);
    }

    if (selected.length < PER_CATEGORY && items.length > selected.length) {
      const rest = items.filter(i => !selected.includes(i))
        .sort((a, b) => b.score - a.score)
        .slice(0, PER_CATEGORY - selected.length);
      selected = selected.concat(rest);
    }

    for (const item of selected) {
      if (item.reason) {
        item.summary = `【编辑推荐】${item.reason}\n${item.summary || ""}`;
      }
      delete item.reason;
      delete item.score;
    }

    if (useAI && selected.length > 0) {
      console.log(`  翻译「${name}」...`);
      await translateToChinese(selected);
    }

    if (useAI && selected.length > 0) {
      console.log(`  分析「${name}」${selected.length}条...`);
      const analysisMap = await analyzeCategoryItems(selected, name);
      selected.forEach((item, i) => { item.analysis = analysisMap[i + 1] || ""; });
    }

    console.log(`  ${name}: ${items.length} 条 → ${selected.length} 条精选\n`);
    allCurated = allCurated.concat(selected);
  }

  // 5. 写入 data.json
  const output = {
    updated: new Date().toISOString(),
    total: allCurated.length,
    items: allCurated,
  };
  writeFileSync(join(__dirname, "data.json"), JSON.stringify(output, null, 2), "utf-8");

  // 6. 归档 + 累积
  updateArchive(date, allCurated);
  updateAllJson(date, allCurated);

  console.log(`✅ 完成! ${allCurated.length} 条精选 → data.json`);
}

main().catch(err => { console.error("❌", err); process.exit(1); });
