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

function gNews(q, locale = "US") {
  const gl = locale === "CN" ? "CN" : "US";
  const hl = locale === "CN" ? "zh-CN" : "en-US";
  const ceid = locale === "CN" ? "CN:zh-Hans" : "US:en";
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
}

// Google News 中文版（从 GitHub Actions US 服务器可访问）
function gNewsCN(q) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
}

const sources = {
  // Google News 中文源
  googleNewsCN: [
    { query: "大模型 OR 人工智能 发布 OR 开源 OR 融资", cat: "ai-progress" },
    { query: "DeepSeek OR 智谱 OR 百度文心 OR 阿里通义 OR 字节豆包 OR 华为盘古", cat: "ai-progress" },
    { query: "AI监管 OR 人工智能治理 OR 算法备案 OR 数据合规 OR 网信办", cat: "ai-regulation" },
    { query: "法律AI OR AI法律 OR 智慧法院 OR 合规科技 OR 法律科技", cat: "legal-ai" },
  ],
  // Google News 英文源
  googleNewsUS: [
    { query: '("AI model" OR "GPT" OR "foundation model" OR "LLM") AND (release OR launch OR breakthrough OR announce) -regulation -law -ban', cat: "ai-progress" },
    { query: '(OpenAI OR Anthropic OR "Google DeepMind" OR Meta OR DeepSeek OR xAI) AND (release OR launch OR funding OR IPO) -regulation -lawsuit -ban', cat: "ai-progress" },
    { query: '("EU AI Act" OR "AI regulation" OR "AI legislation" OR "AI Act") AND (law OR policy OR enforcement OR compliance)', cat: "ai-regulation" },
    { query: '("AI governance" OR "AI executive order" OR "FTC AI" OR "AI liability" OR "AI fine" OR "AI lawsuit")', cat: "ai-regulation" },
    { query: '("legal AI" OR "AI lawyer" OR "legal tech" OR "AI legal" OR "AI contract") AND (AI OR platform OR startup OR funding OR tool)', cat: "legal-ai" },
  ],
  rss: [
    // === 境外权威媒体 ===
    { url: "https://feeds.content.dowjones.io/public/rss/socialeconomyfeed", cat: "ai-progress" },
    { url: "https://www.wired.com/feed/tag/ai/latest/rss", cat: "ai-progress" },
    // === 境外专业AI源 ===
    { url: "https://iapp.org/news/feed/", cat: "ai-regulation" },
    { url: "https://techcrunch.com/category/artificial-intelligence/feed/", cat: "ai-progress" },
    { url: "https://www.technologyreview.com/topic/artificial-intelligence/feed/", cat: "ai-progress" },
    { url: "https://www.artificiallawyer.com/feed", cat: "legal-ai" },
    { url: "https://feeds.feedblitz.com/abajournal/topstories", cat: "legal-ai" },
    { url: "https://www.theverge.com/ai-artificial-intelligence/rss/index.xml", cat: "ai-progress" },
    { url: "https://venturebeat.com/category/ai/feed/", cat: "ai-progress" },
    // === 中国源 ===
    { url: "https://www.36kr.com/feed", cat: "ai-progress", region: "cn" },
    { url: "https://rsshub.app/caixin/latest", cat: "ai-regulation", region: "cn" },
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
  // 英文
  if (/eu ai act|european (union|commission|parliament)/.test(t)) score += 5;
  if (/supreme court|federal court|landmark|ruling/.test(t)) score += 5;
  if (/ftc|sec|doj|department of justice/.test(t)) score += 4;
  if (/white house|executive order|president/.test(t)) score += 4;
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
  // 中文关键词（高分确保中国新闻不被挤出）
  if (/网信办|工信部|国务院|最高法院|最高检|信安标委/.test(t)) score += 6;
  if (/算法备案|数据合规|个人信息保护|生成式|深度合成|大模型|基座模型|基础模型/.test(t)) score += 6;
  if (/deepseek|深度求索|百度|阿里|华为|字节|腾讯|科大讯飞|商汤|旷视/.test(t)) score += 5;
  if (/智谱|月之暗面|kimi|百川|minimax|零一万物|阶跃星辰|面壁|生数/.test(t)) score += 5;
  if (/发布|开源|上线|推出|融资|ipo|上市|收购/.test(t)) score += 3;
  if (/监管|立法|处罚|罚款|整改|约谈|下架|禁令/.test(t)) score += 4;
  if (/智慧法院|智慧司法|法律科技|合规科技/.test(t)) score += 5;
  if (/中国|北京|上海|深圳|杭州|清华|北大|中科院/.test(t)) score += 3;
  if (title.length > 10 && title.length < 200) score += 1;
  return score;
}

// ============================================================
// 抓取函数
// ============================================================

async function fetchGoogleNews({ query, cat, locale }) {
  try {
    const url = locale === "CN" ? gNewsCN(query) : gNews(query);
    const feed = await parser.parseURL(url);
    return feed.items.map(item => ({
      id: "g-" + slug(item.link || item.title),
      title: item.title?.trim() || "",
      url: item.link || "",
      source: extractSource(item.title, item.source),
      summary: clean(item.contentSnippet || item.content || ""),
      date: item.pubDate ? new Date(item.pubDate).toISOString().split("T")[0] : "",
      category: cat,
      score: scoreByKeywords(item.title || ""),
      region: locale === "CN" ? "cn" : "",
    }));
  } catch { return []; }
}

async function fetchRSS({ url, cat, region }) {
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
      region: region || "",
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
    "ai-progress": "AI重大进展：OpenAI/Google/Anthropic/Meta/微软/苹果/英伟达/DeepSeek/百度/阿里/腾讯/华为/字节等头部公司的新模型发布、重大产品更新、技术突破、巨额融资/IPO、行业并购、AI芯片与基础设施。排除：政策法规、行政令、诉讼罚款、监管动态。",
    "ai-regulation": "AI监管动态：各国AI立法/修法、总统/总理签署AI行政令、FTC/SEC/欧盟/中国网信办等AI执法调查罚款、AI版权隐私反垄断诉讼判决、数据安全新规。排除：AI公司产品发布、融资、技术突破。",
    "legal-ai": "法律AI行业：法律科技公司融资/并购/产品发布、头部律所采用AI工具的合作、司法系统AI应用、合规科技。排除：政府AI监管政策、版权诉讼。",
  };

  const def = categoryDefinitions[cat] || "";

  const prompt = `你是"${catName}"栏目的主编。从以下候选新闻中挑选最重要的5条。

栏目定义：
${def}

选择优先级：
1.(最高) OpenAI/Google/Anthropic/Meta/微软/苹果/英伟达/特斯拉/DeepSeek/百度/阿里/腾讯/华为/字节等头部公司的重大新闻；WSJ/FT/Bloomberg/路透/IAPP/TechCrunch/Wired等权威来源
2.(高) 上述公司之外的实质性内容：重大产品发布、突破性技术、大规模融资、重要合作
3.(普通) 行业分析/研究报告/趋势
4.(排除) 公关软文、重复报道、与AI无关

每5条必须包含至少1条中国相关新闻（中国公司/政策/市场/中文权威来源）。

返回JSON：[{index:数字, reason:"15字理由"}]
只返回JSON。

候选：
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
  // 逐条生成，确保标题和内容不会混淆
  return await analyzeOneByOne(items, catName);
}

async function analyzeOneByOne(items, catName) {
  const map = {};
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    console.log(`    分析第${i+1}/5条: ${item.title.substring(0, 30)}...`);
    const prompt = `请为以下这条"${catName}"新闻撰写解读（约200-350字中文）。

⚠️ 最关键要求：解读内容必须严格基于该新闻的标题和摘要，不要编造标题和摘要中没有的信息。不得张冠李戴。

结构：
【事件概述】4-6句话，基于标题和摘要详细介绍该事件。必须写出真实公司/机构/人名称，日期必须具体。禁止使用"某公司""某律所""某机构"等模糊表述。
【行业影响】2-3句话分析重要性。

标题：${item.title}
来源：${item.source}
日期：${item.date}
摘要：${item.summary || "无"}

不要markdown，不要链接，不要emoji。直接返回解读文本。`;

    try {
      const text = await askDeepSeek([{ role: "user", content: prompt }]);
      map[i + 1] = text.trim();
    } catch (err) {
      console.log(`      失败: ${err.message}`);
      map[i + 1] = "";
    }
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
    ...sources.googleNewsCN.map(q => fetchGoogleNews({ ...q, locale: "CN" })),
    ...sources.googleNewsUS.map(q => fetchGoogleNews(q)),
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

  // 3.5 事后分类调整
  // 3.5a：过滤非AI新闻
  const aiKeywords = /AI|人工智能|大模型|LLM|GPT|ChatGPT|Claude|DALL|Midjourney|Stable Diffusion|Gemini|AlphaFold|模型|算法|机器学习|深度学习|神经网络|机器人|自动驾驶|AI模型|生成式|深度学习|NLP|计算机视觉|machine learning|deep learning|neural network|transformer|diffusion|生成式AI|大语言模型|基座模型|向量数据库|RAG|Agent|智能体|提示词|prompt|fine-?tun|训练|推理|算力|GPU|芯片|数据中心|AI芯片/;
  let preFiltered = all.length;
  all = all.filter(item => {
    const t = (item.title || "") + " " + (item.summary || "");
    return aiKeywords.test(t);
  });
  if (all.length < preFiltered) console.log(`📊 过滤非AI新闻: ${preFiltered - all.length} 条`);

  // 3.5b：36kr中国新闻按内容分发到三个分类
  const cnRegKW = /监管|处罚|罚款|禁令|立法|网信办|工信部|数据合规|个人信息|隐私|安全审查|约谈|下架|整改|备案|算法推荐|深度合成/;
  const cnLegalKW = /法律|法院|法官|律师|司法|诉讼|仲裁|合同|合规科技|智慧法院|AI律师|AI法律|法务/;
  let cnDistributed = 0;
  for (const item of all) {
    if (item.region === "cn") {
      if (cnRegKW.test(item.title || "")) {
        item.category = "ai-regulation";
        cnDistributed++;
      } else if (cnLegalKW.test(item.title || "")) {
        item.category = "legal-ai";
        cnDistributed++;
      }
      // else stays ai-progress
    }
  }
  if (cnDistributed > 0) console.log(`📊 36kr中文新闻分发: ${cnDistributed} 条 → 监管/法律AI`);

  // 3.5b：明显属于监管的英文新闻纠正
  const regKW = /executive order|president.*sign|white house.*ai|ai.*ban|ai.*fine|ai.*penalty|ai.*lawsuit|ai.*court.*rul|ai.*regulation|ai.*legislation|ai.*act|eu.*ai|ftc.*ai|doj.*ai|ai.*probe|ai.*investigation|ai.*enforcement/i;
  let reclassified = 0;
  for (const item of all) {
    if (item.category === "ai-progress" && regKW.test(item.title.toLowerCase() || "")) {
      item.category = "ai-regulation";
      reclassified++;
    }
  }
  if (reclassified > 0) console.log(`📊 英文重分类: ${reclassified} 条 → ai-regulation`);

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

    // 每分类固定1条中国新闻，不多不少
    function isCNItem(item) {
      if (item.region === "cn") return true;
      if (item.source && /(36kr|虎嗅|jiqizhixin|机器之心|澎湃|新华|人民|sina|sohu|netease|qq\.com|baidu|zhihu|财新|钛媒体|极客公园)/i.test(item.source)) return true;
      const cnChars = (item.title || "").match(/[一-鿿]/g)?.length || 0;
      const enChars = (item.title || "").match(/[a-zA-Z]/g)?.length || 0;
      if (cnChars > 15 && cnChars > enChars * 3) return true;
      return false;
    }

    const cnItems = items.filter(i => !selected.includes(i) && isCNItem(i))
      .sort((a, b) => (b.score || 0) - (a.score || 0));
    const nonCNSelected = selected.filter(i => !isCNItem(i));
    const cnSelected = selected.filter(isCNItem);

    if (cnSelected.length >= 2) {
      // 太多中国新闻：只保留最高分那条，其余换回境外
      const keep = cnSelected.sort((a, b) => (b.score || 0) - (a.score || 0))[0];
      const extra = cnSelected.filter(i => i !== keep);
      selected = [...nonCNSelected, keep];
      const pool = items.filter(i => !selected.includes(i) && !isCNItem(i)).sort((a, b) => (b.score || 0) - (a.score || 0));
      for (let i = 0; i < Math.min(extra.length, pool.length); i++) {
        selected.push(pool[i]);
      }
      selected = selected.slice(0, PER_CATEGORY);
      console.log(`  中国新闻过多(${cnSelected.length}条)，削减为1条`);
    } else if (cnSelected.length === 0 && cnItems.length > 0) {
      // 没有中国新闻：替换最低分境外新闻
      const lowest = [...nonCNSelected].sort((a, b) => (a.score || 0) - (b.score || 0))[0];
      selected = selected.filter(i => i !== lowest);
      selected.push(cnItems[0]);
      console.log(`  补入中国新闻: ${cnItems[0].title?.substring(0, 40)}`);
    }
    console.log(`  中国新闻: ${selected.filter(isCNItem).length}/${PER_CATEGORY}`);

    for (const item of selected) {
      if (item.reason) {
        item.summary = `【编辑推荐】${item.reason}\n${item.summary || ""}`;
      }
      delete item.reason;
      delete item.region;
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
