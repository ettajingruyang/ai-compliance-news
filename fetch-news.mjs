import Parser from "rss-parser";
import { writeFileSync } from "fs";
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

// Google News 关键词搜索
function gNews(q) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
}

const sources = {
  googleNews: [
    // --- AI 监管 (中文) ---
    { query: '("AI监管" OR "人工智能治理" OR "AI立法" OR "算法备案")', cat: "ai-regulation" },
    // --- AI 监管 (英文) ---
    { query: '("EU AI Act" OR "AI regulation" OR "AI legislation") AND (law OR policy OR enforcement OR act)', cat: "ai-regulation" },
    { query: '("AI governance" OR "AI compliance" OR "FTC AI" OR "AI liability")', cat: "ai-regulation" },
    // --- 法律AI (中文) ---
    { query: '("法律AI" OR "AI法律" OR "智能司法" OR "合规科技")', cat: "legal-ai" },
    // --- 法律AI (英文) ---
    { query: '("legal AI" OR "AI lawyer" OR "AI copyright" OR "AI court" OR "AI litigation")', cat: "legal-ai" },
    // --- AI进展 (中文) ---
    { query: '("大模型" OR "人工智能" OR "AI") AND (发布 OR 开源 OR 突破 OR 进展)', cat: "ai-progress" },
    { query: '(OpenAI OR Anthropic OR 百度 OR 阿里 OR 华为 OR DeepSeek OR 智谱 OR Kimi) AND (AI OR 模型)', cat: "ai-progress" },
    // --- AI进展 (英文) ---
    { query: '("AI model" OR "GPT-5" OR "foundation model") AND (release OR launch OR breakthrough OR announce)', cat: "ai-progress" },
    { query: '(OpenAI OR Anthropic OR "Google DeepMind" OR Meta OR DeepSeek) AND (AI OR model)', cat: "ai-progress" },
  ],
  rss: [
    // 境外监管/法律
    { url: "https://iapp.org/news/feed/", cat: "ai-regulation" },
    { url: "https://techcrunch.com/category/artificial-intelligence/feed/", cat: "ai-progress" },
    { url: "https://www.technologyreview.com/topic/artificial-intelligence/feed/", cat: "ai-progress" },
    { url: "https://www.artificiallawyer.com/feed", cat: "legal-ai" },
    { url: "https://feeds.feedblitz.com/abajournal/topstories", cat: "legal-ai" },
    // 中国来源
    { url: "https://www.jiqizhixin.com/rss", cat: "ai-progress" },
    { url: "https://rsshub.app/36kr/motif/327403059714547", cat: "ai-progress" },
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

// 用关键词给新闻打分（越高越重要）
function scoreByKeywords(title) {
  const t = title.toLowerCase();
  let score = 0;
  // 权威机构/关键词加分
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
  // 标题长度合理（太短或太长都不好）
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
      summary: h.story_text ? clean(h.story_text).substring(0, 200) : `💬 ${h.num_comments || 0} 条讨论 • ⭐ ${h.points || 0} 分`,
      date: h.created_at ? h.created_at.split("T")[0] : "",
      category: cat,
      score: scoreByKeywords(h.title || "") + Math.min((h.points || 0) / 50, 5),
    }));
  } catch { return []; }
}

// ============================================================
// DeepSeek — 精选 + 写解读
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

// 判断文本是否已经包含中文
function hasChinese(text) {
  return /[一-鿿]/.test(text || "");
}

// 批量翻译非中文标题和摘要
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

  // 先按评分选出 top 30，再交给 AI 精选
  const candidates = items.sort((a, b) => b.score - a.score).slice(0, 30);

  const list = candidates.map((item, i) =>
    `[${i + 1}] ${item.title} | 来源: ${item.source} | 日期: ${item.date}\n  摘要: ${item.summary.substring(0, 150)}`
  ).join("\n\n");

  const prompt = `你是一个AI合规与法律AI领域的专业编辑。请从以下候选新闻中，为"${catName}"栏目挑选最重要的5条新闻。

挑选标准：
- 优先选择有重大影响的：新法规通过、大额罚款、重大执法行动、重要模型发布、里程碑式裁决
- 其次选择对行业有参考价值的：政策动态、企业合规实践、研究报告
- 略过纯营销内容、重复报道、无实质信息的文章

请返回JSON数组，每个元素包含：选中的序号(index, 数字)、选择理由(reason, 中文, 20字以内)。
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

async function writeHeadlineAnalysis(item) {
  const prompt = `你是一个AI合规与法律AI领域的资深分析师。请针对以下今日最重要的AI合规/法律AI新闻，写一段专业分析（150-250字中文）。

格式要求：
- 第一段：简要介绍事件
- 第二段：分析为什么它重要、对行业意味着什么

新闻标题：${item.title}
来源：${item.source}
日期：${item.date}
摘要：${item.summary || "无"}`;

  try {
    return await askDeepSeek([{ role: "user", content: prompt }]);
  } catch (err) {
    console.log(`    ⚠️ 头条分析生成失败: ${err.message}`);
    return "";
  }
}

// 为一个分类的5条新闻批量生成详细解读（300-500字中文）
async function analyzeCategoryItems(items, catName) {
  if (items.length === 0) return {};

  const list = items.map((item, i) =>
    `[${i + 1}] 标题: ${item.title}\n    来源: ${item.source}\n    日期: ${item.date}\n    原文链接: ${item.url}\n    原始摘要: ${item.summary?.substring(0, 300) || "无"}`
  ).join("\n\n");

  const prompt = `你是一个AI合规与法律AI领域的资深分析师。请为以下"${catName}"栏目的${items.length}条新闻分别撰写详细解读。

每条解读要求（300-500字中文）：
- 第一段：详细介绍该新闻事件的具体内容、背景、涉及方
- 第二段：专业分析该事件的重要性、对行业的影响、未来趋势
- 结尾：附上"原文链接: [新闻链接]"
- 不要使用markdown格式，纯文字即可

请返回JSON数组，每个元素包含：序号(index, 数字)、解读(analysis, 中文, 300-500字)。
只返回JSON，不要其他文字。

新闻列表：
${list}`;

  try {
    const resp = await askDeepSeek([{ role: "user", content: prompt }]);
    // 尝试提取 JSON 数组
    let jsonStr = resp.match(/\[[\s\S]*\]/)?.[0];
    if (!jsonStr) {
      // Fallback: 如果 AI 返回的不是标准JSON数组，尝试提取每一段
      console.log(`    ⚠️ 批量分析(${catName}): AI 返回格式不对，尝试逐条提取`);
      const map = {};
      items.forEach((_, i) => { map[i + 1] = ""; });
      return map;
    }
    // 清理可能导致 JSON 解析失败的字符
    jsonStr = jsonStr.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, "");
    const json = JSON.parse(jsonStr);
    const map = {};
    json.forEach(j => { if (j.index != null) map[j.index] = j.analysis || ""; });
    return map;
  } catch (err) {
    console.log(`    ⚠️ 批量分析(${catName}): JSON解析失败, ${err.message}`);
    // fallback to empty
    return {};
  }
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

  // 1. 抓取所有来源
  const tasks = [
    ...sources.googleNews.map(q => fetchGoogleNews(q)),
    ...sources.rss.map(r => fetchRSS(r)),
    ...sources.hn.map(h => fetchHN(h)),
  ];
  console.log(`📡 正在抓取 ${tasks.length} 个信息源...\n`);
  const results = await Promise.all(tasks);
  let all = results.flat();
  console.log(`📊 原始抓取: ${all.length} 条`);

  // 2. 去重（按URL）
  const seen = new Set();
  all = all.filter(item => {
    const k = item.url || item.id;
    if (!k || seen.has(k)) return false;
    if (!item.title || !item.url) return false;
    seen.add(k);
    return true;
  });
  console.log(`📊 去重后: ${all.length} 条`);

  // 3. 只保留近7天
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
  all = all.filter(item => item.date >= cutoff);
  console.log(`📊 近7天: ${all.length} 条`);

  // 4. 每分类精选 5 条 + 全部分析
  const catNames = { "ai-progress": "AI重大进展", "ai-regulation": "AI监管动态", "legal-ai": "法律AI" };
  const PER_CATEGORY = 5;

  const aiLabel = useAI ? "🤖 正在用 DeepSeek 精选 + 分析各分类新闻..." : "📊 正在用关键词评分排序各分类新闻...";
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

    // 不足5条时用评分补足
    if (selected.length < PER_CATEGORY && items.length > selected.length) {
      const rest = items.filter(i => !selected.includes(i))
        .sort((a, b) => b.score - a.score)
        .slice(0, PER_CATEGORY - selected.length);
      selected = selected.concat(rest);
    }

    // 附上选择理由
    for (const item of selected) {
      if (item.reason) {
        item.summary = `【编辑推荐】${item.reason}
${item.summary || ""}`;
      }
      delete item.reason;
      delete item.score;
    }

    // 翻译非中文内容
    if (useAI && selected.length > 0) {
      console.log(`  正在将「${name}」非中文内容翻译为中文...`);
      await translateToChinese(selected);
    }

    // 批量生成解读
    if (useAI && selected.length > 0) {
      console.log(`  正在为「${name}」${selected.length}条新闻生成解读...`);
      const analysisMap = await analyzeCategoryItems(selected, name);
      selected.forEach((item, i) => {
        // 1-indexed matching
        item.analysis = analysisMap[i + 1] || "";
      });
    }

    console.log(`  ${name}: ${items.length} 条 → 精选 ${selected.length} 条`);
    allCurated = allCurated.concat(selected);
  }

  // 5. 写入
  const output = {
    updated: new Date().toISOString(),
    total: allCurated.length,
    items: allCurated,
  };

  writeFileSync(join(__dirname, "data.json"), JSON.stringify(output, null, 2), "utf-8");
  console.log(`\n✅ 完成! 共 ${allCurated.length} 条精选新闻 → data.json`);
}

main().catch(err => { console.error("❌", err); process.exit(1); });
