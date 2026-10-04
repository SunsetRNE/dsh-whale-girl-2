import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { load } from "js-yaml";
import { fileURLToPath } from "node:url";
//#region src/services/balance.ts
async function fetchBalance(apiKey, fetchImpl = fetch) {
	const res = await fetchImpl("https://api.deepseek.com/user/balance", { headers: { Authorization: `Bearer ${apiKey}` } });
	if (!res.ok) throw new Error(`balance api failed: ${res.status}`);
	const info = (await res.json()).balance_infos?.[0];
	if (!info || info.total_balance === void 0) throw new Error("balance response malformed");
	return {
		totalBalance: Number(info.total_balance),
		currency: info.currency ?? "CNY"
	};
}
/**
* 硅基流动余额：GET {base}/user/info → data.balance / data.totalBalance。
* base 从 provider 的 baseURL 推导（CN: api.siliconflow.cn/v1，国际: api.siliconflow.com/v1，
* 两者账号体系独立）。CN 域名的该端点已于 2026-08 被 410 废弃且暂无替代，
* 失败时由调用方回退到通用探测链。
*/
async function fetchSiliconflowBalance(apiKey, fetchImpl = fetch, base = "https://api.siliconflow.cn/v1") {
	const res = await fetchImpl(`${base.replace(/\/+$/, "")}/user/info`, { headers: { Authorization: `Bearer ${apiKey}` } });
	if (!res.ok) throw new Error(`siliconflow balance failed: ${res.status}`);
	const json = await res.json();
	const raw = json.data?.totalBalance ?? json.data?.balance;
	if (raw === void 0) throw new Error("siliconflow balance missing");
	return {
		totalBalance: Number(raw),
		currency: "CNY"
	};
}
/**
* 从任意 OpenAI 兼容响应里尽力提取余额数字。
* 兼容多种字段命名（balance / total_balance / credit / remaining 等常见拼写）。
*/
function extractBalance(json) {
	if (json === null || typeof json !== "object") return null;
	const o = json;
	for (const k of [
		"balance",
		"total_balance",
		"totalBalance",
		"credit",
		"credits",
		"remaining",
		"quota"
	]) {
		const v = o[k];
		if (typeof v === "number" && isFinite(v)) return v;
		if (typeof v === "string" && v.trim() !== "" && isFinite(Number(v))) return Number(v);
	}
	if (o.data && typeof o.data === "object") {
		const inner = extractBalance(o.data);
		if (inner !== null) return inner;
	}
	if (Array.isArray(o.balance_infos)) {
		const first = o.balance_infos[0];
		if (first && first.total_balance !== void 0 && isFinite(Number(first.total_balance))) return Number(first.total_balance);
	}
	return null;
}
/**
* 通用余额探测链：对任意的 OpenAI 兼容 baseURL，依次尝试各平台常见的
* 余额/账户端点；返回第一个给出可解析余额的结果。没有公开余额 API 的
* 平台（如智谱）会全部失败，调用方据此显示"余额未知"。
*/
const GENERIC_BALANCE_PATHS = [
	"/dashboard/billing/credit_grants",
	"/dashboard/billing/subscription",
	"/user/balance",
	"/v1/user/info",
	"/v1/dashboard/billing/credit_grants",
	"/api/user/balance",
	"/account/balance"
];
async function probeGenericBalance(baseURL, apiKey, fetchImpl = fetch) {
	const base = baseURL.replace(/\/+$/, "");
	const auth = { Authorization: `Bearer ${apiKey}` };
	for (const p of GENERIC_BALANCE_PATHS) try {
		const res = await fetchImpl(`${base}${p}`, { headers: auth });
		if (!res.ok) continue;
		if (!(res.headers.get("content-type") ?? "").includes("json")) continue;
		const balance = extractBalance(await res.json());
		if (balance !== null) return {
			totalBalance: balance,
			currency: "CNY"
		};
	} catch {}
	return null;
}
/** 已知提供方家族的专用实现（优先于通用探测）。 */
const BALANCE_FETCHERS = {
	deepseek: fetchBalance,
	siliconflow: fetchSiliconflowBalance
};
/** 查任意提供方余额：先按已知家族的专用 API，再退回通用端点探测链。 */
async function fetchProviderBalance(query, apiKey, fetchImpl = fetch) {
	if (query.family === "siliconflow") try {
		return await fetchSiliconflowBalance(apiKey, fetchImpl, query.baseURL ?? "https://api.siliconflow.cn/v1");
	} catch {}
	const known = BALANCE_FETCHERS[query.family];
	if (known) try {
		return await known(apiKey, fetchImpl);
	} catch {}
	if (query.baseURL) return probeGenericBalance(query.baseURL, apiKey, fetchImpl);
	return null;
}
/**
* 用量分桶用的时区偏置：北京时间 UTC+8。
* 必须与 src/index.ts 的峰谷判断（isPeakTime 里同样 +8h）用同一个口径 ——
* 否则 UTC+8 用户会在每天北京时间 08:00 看到「今日用量」归零，而峰谷却按北京日历日切。
*/
const TZ_OFFSET_MS = 288e5;
function todayStr(d = /* @__PURE__ */ new Date()) {
	return new Date(d.getTime() + TZ_OFFSET_MS).toISOString().slice(0, 10);
}
var Ledger = class {
	state = {
		date: todayStr(),
		lastBalance: null,
		todayUsage: 0,
		history: []
	};
	observe(balance, date = todayStr()) {
		if (this.state.date !== date) {
			if (this.state.todayUsage > 0) {
				this.state.history.push({
					date: this.state.date,
					usage: this.state.todayUsage
				});
				if (this.state.history.length > 30) this.state.history.shift();
			}
			this.state.date = date;
			this.state.todayUsage = 0;
			this.state.lastBalance = null;
		}
		if (this.state.lastBalance !== null && balance < this.state.lastBalance) this.state.todayUsage += this.state.lastBalance - balance;
		this.state.lastBalance = balance;
		return this.state;
	}
	load(raw) {
		try {
			const parsed = JSON.parse(raw);
			this.state = {
				date: typeof parsed.date === "string" ? parsed.date : this.state.date,
				lastBalance: typeof parsed.lastBalance === "number" ? parsed.lastBalance : null,
				todayUsage: typeof parsed.todayUsage === "number" ? parsed.todayUsage : 0,
				history: Array.isArray(parsed.history) ? parsed.history : []
			};
		} catch {}
	}
	save(path) {
		fs.writeFileSync(path, JSON.stringify(this.state));
	}
};
//#endregion
//#region src/services/providers.ts
/**
* provider / model 标识符的合法形状（settings.yaml 里这类键就是 `[A-Za-z0-9._-]`）。
* selectModel 会把这两个值写回 DSH 的全局 settings.yaml，必须先在入口挡掉
* 换行、引号、`$`、冒号等能改变 YAML 结构或干扰 String.replace 替换串的字符。
*/
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;
/**
* 把值放进 String.replace 的替换串前先做最小转义。
* 替换串里 `$&` / `$'` / `` $` `` / `$1` 有特殊含义，会被展开成匹配内容或上下文；
* 直接拼接用户输入会让 replacement 语义被劫持（并可能复制出多行文本）。
* 换行在这里是兜底二道防线：入口 SAFE_ID 已经挡过一次。
*/
function yamlScalar(v) {
	return v.replace(/[\r\n]/g, " ").replace(/\$/g, "$$$$");
}
function settingsPath() {
	const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
	return path.join(home, "settings.yaml");
}
/** 从 provider key 推断余额查询家族。 */
function familyOf(id) {
	if (id.includes("deepseek")) return "deepseek";
	if (id.includes("siliconflow")) return "siliconflow";
	if (id.includes("zai") || id.includes("zhipu") || id.includes("glm") || id.includes("bigmodel")) return "zhipu";
	return id;
}
function displayNameOf(id) {
	return {
		"deepseek-official": "DeepSeek 官方",
		siliconflow: "硅基流动",
		"zai-coding-cn": "智谱 GLM"
	}[id] ?? id;
}
/** 从一个 provider 配置对象里提取 apiKeyEnv / baseURL / models。 */
function entryFromConfig(id, cfg) {
	const o = cfg && typeof cfg === "object" ? cfg : {};
	let models;
	if (Array.isArray(o.models)) models = o.models.map((m) => m && typeof m === "object" ? String(m.id ?? "") : String(m)).filter((s) => s !== "");
	return {
		id,
		name: displayNameOf(id),
		family: familyOf(id),
		apiKeyEnv: typeof o.apiKeyEnv === "string" ? o.apiKeyEnv : void 0,
		baseURL: typeof o.baseURL === "string" ? o.baseURL : void 0,
		models: models && models.length > 0 ? models : void 0
	};
}
/**
* 读取 settings.yaml，返回可切换的提供方列表。
* 用完整 YAML 解析（js-yaml），覆盖任意书写风格；始终包含内置的 DeepSeek 官方。
*/
function listProviders() {
	let providers = [];
	try {
		const doc = load(fs.readFileSync(settingsPath(), "utf8")) ?? {};
		const sections = [doc["llm-pi-ai"]?.providers, doc["llm-openai-compatible"]?.providers];
		for (const section of sections) if (section && typeof section === "object") {
			for (const [id, cfg] of Object.entries(section)) if (!providers.some((p) => p.id === id)) providers.push(entryFromConfig(id, cfg));
		}
	} catch {
		providers = [];
	}
	if (!providers.some((p) => p.id === "deepseek-official")) providers.unshift({
		id: "deepseek-official",
		name: displayNameOf("deepseek-official"),
		family: "deepseek",
		apiKeyEnv: "DEEPSEEK_API_KEY",
		models: ["deepseek-v4-flash", "deepseek-v4-pro"]
	});
	return providers;
}
/** 当前默认模型路由（settings.yaml 的 agent-default-model）。 */
function currentModel() {
	try {
		const m = (load(fs.readFileSync(settingsPath(), "utf8")) ?? {})["agent-default-model"];
		return {
			provider: typeof m?.provider === "string" ? m.provider : "",
			model: typeof m?.model === "string" ? m.model : ""
		};
	} catch {
		return {
			provider: "",
			model: ""
		};
	}
}
/**
* 切换全局默认模型路由（写 settings.yaml 的 agent-default-model）。
* 用行级替换保持文件其余部分（注释、格式）不动；返回是否成功。
*/
function selectModel(provider, model) {
	if (!SAFE_ID.test(provider) || !SAFE_ID.test(model)) return false;
	try {
		const p = settingsPath();
		const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
		const out = [];
		let inAdm = false;
		let wroteProvider = false;
		let wroteModel = false;
		for (const line of lines) {
			const top = /^([A-Za-z0-9_-]+):/.exec(line);
			if (top) {
				inAdm = top[1] === "agent-default-model";
				out.push(line);
				continue;
			}
			if (inAdm && /^\s+provider:/.test(line)) {
				out.push(line.replace(/provider:.*/, `provider: ${yamlScalar(provider)}`));
				wroteProvider = true;
				continue;
			}
			if (inAdm && /^\s+model:/.test(line)) {
				out.push(line.replace(/model:.*/, `model: ${yamlScalar(model)}`));
				wroteModel = true;
				continue;
			}
			out.push(line);
		}
		if (!wroteProvider || !wroteModel) return false;
		try {
			fs.copyFileSync(p, `${p}.whale-girl.bak`);
		} catch {}
		const tmp = `${p}.tmp-${randomUUID()}`;
		fs.writeFileSync(tmp, out.join("\n"), "utf8");
		fs.renameSync(tmp, p);
		return true;
	} catch {
		return false;
	}
}
//#endregion
//#region src/services/context.ts
const DEFAULT_CONTEXT_LIMIT = 6e5;
function computeContextPct(tokens, limit) {
	if (limit <= 0 || tokens <= 0) return 0;
	return Math.min(1, tokens / limit);
}
//#endregion
//#region src/services/turnCost.ts
/**
* 单价（元 / 百万 token）。沿用作者原值，**未独立核价** —— 模型调价时改这里。
* 旧版把这两个数字硬编码在 src/index.ts 的调用点里，改价要翻源码。
*/
const DEEPSEEK_PRICE = {
	input: .5,
	output: 2
};
/**
* 退化估算：只有总 token、拿不到输入/输出拆分时使用（tokenMeter.measure() 目前只给总量）。
* 全部按输入价折算 —— 这个口径**偏低**，UI 上必须标成「估算」而不是确定值。
* 存在意义是让调用点不必再编一个假的拆分：旧调用点传的是
* `{ inputTokens: total, outputTokens: 0 }`，等于宣称「本轮全部是输入」。
*/
function estimateCostUnsplit(totalTokens, price) {
	if (totalTokens <= 0) return 0;
	return totalTokens * price.input / 1e6;
}
//#endregion
//#region src/index.ts
const name = "dsh-whale-girl-2";
const inject = [
	"webServer",
	"credentials",
	"timer",
	"tokenMeter",
	"sessions",
	"agents"
];
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const USAGE_FILE = path.join(DSH_HOME, ".whale-girl-usage.json");
const CONFIG_FILE = path.join(DSH_HOME, ".whale-girl-config.json");
const DIAG_FILE = path.join(DSH_HOME, ".whale-girl-diag.log");
/** CPU 采样缓存（用 os.cpus() 时间差计算占用，Windows 无 loadavg）。 */
let lastCpuTimes = null;
const ASSET_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets");
/**
* 日志转义：diag 的部分参数来自 HTTP 请求体（如 select-model 的 provider / model），
* 未净化直接落盘时，一个 `\n` 就能伪造出一条日志行（实测：provider="a\nb" 把一行拆成两行）。
* 控制字符统一转成可见形式，日志每行恒定对应一条记录。
*/
function escapeLog(line) {
	return line.replace(/[\u0000-\u001f\u007f]/g, (c) => {
		const code = c.charCodeAt(0);
		if (code === 10) return "\\n";
		if (code === 13) return "\\r";
		if (code === 9) return "\\t";
		return "\\x" + code.toString(16).padStart(2, "0");
	});
}
/** 诊断记录（排查 client 数据是否到达、host 数据是否就绪）。用完可删除该日志文件。 */
function diag(line) {
	try {
		let size = 0;
		try {
			size = fs.statSync(DIAG_FILE).size;
		} catch {
			size = 0;
		}
		if (size > 1048576) fs.renameSync(DIAG_FILE, DIAG_FILE + ".old");
		fs.appendFileSync(DIAG_FILE, `[${(/* @__PURE__ */ new Date()).toISOString()}] ${escapeLog(line)}\n`);
	} catch {}
}
/** 详单级诊断（measure 全量 JSON 等）。默认关闭：它每次 /api/state 都会写 800 字节，属于写入热点。 */
const DEBUG = process.env.WHALE_GIRL_DEBUG === "1";
/**
* 官方 DeepSeek 路由的凭据引用名。
*
* 旧版硬编码 'DEEPSEEK_API_KEY'，但在 DSHA 环境里官方 provider 的 apiKeyEnv 被
* profile 的 cordis.patch.yml 覆盖成了 'DSHA_DEEPSEEK_OFFICIAL_API_KEY'，
* 于是 resolve 永远拿不到值，日志里只剩一行 'refresh: no-key'、余额恒为 null。
*
* DSH 自己的做法（dsh-llm-deepseek-api-key/lib/index.js:40-49）是**从 connection.apiKeyEnv
* 取引用名**、再退回启动环境变量。这里在插件拿不到 connection 的前提下退而求其次：
* 按候选名逐个 resolve，命中即用；可用 WHALE_GIRL_KEY_REF 显式指定。
* 日志只记录**引用名**，绝不记录值。
*/
const OFFICIAL_KEY_REFS = [
	process.env.WHALE_GIRL_KEY_REF ?? "",
	"DSHA_DEEPSEEK_OFFICIAL_API_KEY",
	"DEEPSEEK_API_KEY",
	"DEEPSEEK_OFFICIAL_API_KEY"
].filter((s) => s !== "");
/** 把凭据服务的返回值统一成字符串：它可能直接给字符串，也可能给 { value }。 */
function unwrapCredential(hit) {
	if (typeof hit === "string") return hit.length > 0 ? hit : void 0;
	if (hit && typeof hit === "object") {
		const v = hit.value;
		return typeof v === "string" && v.length > 0 ? v : void 0;
	}
}
/** 逐个候选引用名取密钥，返回命中的名字与值（值只在本进程内存里流转，不落日志）。 */
async function resolveOfficialKey(creds) {
	for (const ref of OFFICIAL_KEY_REFS) {
		try {
			const key = unwrapCredential(await creds.resolve(ref));
			if (key !== void 0) return {
				key,
				ref
			};
		} catch {}
		const ambient = process.env[ref];
		if (typeof ambient === "string" && ambient.length > 0) return {
			key: ambient,
			ref: `${ref} (env)`
		};
	}
	return null;
}
const DEFAULT_CONFIG = {
	soundMode: "cute",
	showProgress: true,
	showBubble: true,
	showBalance: true,
	showPeak: true,
	slingPower: 20,
	ecoMode: true,
	frost: 4,
	panelOpacity: .82,
	lowBalance: 10,
	showWorkState: true,
	realtimeBalance: false,
	showInfo: false,
	followThreshold: 180,
	infoFrost: 4,
	pauseOnThinking: true,
	widgetScale: 1,
	infoScale: 1,
	linkScale: false,
	gravityMode: false,
	ropeMode: false,
	ropeK: 80,
	ropeDamp: 3,
	ropeMax: 150,
	bounceE: 1,
	groundFriction: .95,
	deepSleep: true,
	snapMargin: 0,
	snapInset: 12,
	snapOnRelease: true
};
function normalizeConfig(raw) {
	const o = raw && typeof raw === "object" ? raw : {};
	const power = Number(o.slingPower);
	return {
		soundMode: o.soundMode === "duck" ? "duck" : "cute",
		showProgress: o.showProgress !== false,
		showBubble: o.showBubble !== false,
		showBalance: o.showBalance !== false,
		showPeak: o.showPeak !== false,
		slingPower: Number.isFinite(power) ? Math.min(60, Math.max(5, power)) : 20,
		ecoMode: o.ecoMode !== false,
		frost: Number.isFinite(Number(o.frost)) ? Math.min(16, Math.max(0, Math.round(Number(o.frost)))) : 4,
		panelOpacity: Number.isFinite(Number(o.panelOpacity)) ? Math.min(1, Math.max(.2, Number(o.panelOpacity))) : .82,
		lowBalance: Number.isFinite(Number(o.lowBalance)) ? Math.max(0, Number(o.lowBalance)) : 10,
		showWorkState: o.showWorkState !== false,
		realtimeBalance: o.realtimeBalance === true,
		showInfo: o.showInfo === true,
		followThreshold: Number.isFinite(Number(o.followThreshold)) ? Math.min(360, Math.max(60, Math.round(Number(o.followThreshold)))) : 180,
		infoFrost: Number.isFinite(Number(o.infoFrost)) ? Math.min(16, Math.max(0, Math.round(Number(o.infoFrost)))) : 4,
		pauseOnThinking: o.pauseOnThinking !== false,
		widgetScale: Number.isFinite(Number(o.widgetScale)) ? Math.min(1.5, Math.max(.6, Number(o.widgetScale))) : 1,
		infoScale: Number.isFinite(Number(o.infoScale)) ? Math.min(1.5, Math.max(.6, Number(o.infoScale))) : 1,
		linkScale: o.linkScale === true,
		gravityMode: o.gravityMode === true,
		ropeMode: o.ropeMode === true,
		ropeK: Number.isFinite(Number(o.ropeK)) ? Math.min(200, Math.max(20, Number(o.ropeK))) : 80,
		ropeDamp: Number.isFinite(Number(o.ropeDamp)) ? Math.min(10, Math.max(0, Number(o.ropeDamp))) : 3,
		ropeMax: Number.isFinite(Number(o.ropeMax)) ? Math.min(400, Math.max(40, Number(o.ropeMax))) : 150,
		bounceE: Number.isFinite(Number(o.bounceE)) ? Math.min(1, Math.max(.1, Number(o.bounceE))) : 1,
		groundFriction: Number.isFinite(Number(o.groundFriction)) ? Math.min(.99, Math.max(.8, Number(o.groundFriction))) : .95,
		deepSleep: o.deepSleep !== false,
		snapMargin: Number.isFinite(Number(o.snapMargin)) ? Math.min(200, Math.max(0, Math.round(Number(o.snapMargin)))) : 0,
		snapInset: Number.isFinite(Number(o.snapInset)) ? Math.min(60, Math.max(0, Number(o.snapInset))) : 12,
		snapOnRelease: o.snapOnRelease !== false
	};
}
function safeRegister(server, entry) {
	try {
		server.register(entry);
	} catch (e) {
		diag(`register-skip ${entry?.path ?? "?"}: ${e?.message ?? String(e)}`);
	}
}
function registerAssetRoutes(ctx) {
	const webServer = ctx.get("webServer");
	if (!webServer) return;
	for (const f of [
		"whale-girl.png",
		"Ya1.mp3",
		"Ya2.mp3"
	]) safeRegister(webServer, {
		kind: "exact",
		path: `/dsh-whale-girl-2/${f}`,
		handler: (req, res) => {
			try {
				const buf = fs.readFileSync(path.join(ASSET_ROOT, f));
				res.writeHead(200, {
					"Content-Type": f.endsWith(".mp3") ? "audio/mpeg" : "image/png",
					"Cache-Control": "public, max-age=86400, immutable",
					"Content-Length": String(buf.length)
				});
				res.end(buf);
			} catch {
				res.writeHead(404);
				res.end();
			}
		}
	});
}
function apply(ctx) {
	diag("apply-ok");
	registerAssetRoutes(ctx);
	const ledger = new Ledger();
	try {
		ledger.load(fs.readFileSync(USAGE_FILE, "utf8"));
	} catch {}
	let widgetConfig = DEFAULT_CONFIG;
	try {
		const raw = fs.readFileSync(CONFIG_FILE, "utf8");
		widgetConfig = normalizeConfig(JSON.parse(raw));
	} catch {}
	/**
	* 配置落盘：原子写 + 留档。
	* 旧写法是裸 writeFileSync —— 写到一半被中断会留下截断的 JSON，
	* 下次启动 normalizeConfig 解析失败就静默退回全部默认值（用户的尺寸/音效设置悄悄丢失）。
	* 这里先备 .bak 再 rename：原始值永远可从 .whale-girl-config.json.bak 取回。
	*/
	function writeConfigFile(cfg) {
		try {
			try {
				fs.copyFileSync(CONFIG_FILE, CONFIG_FILE + ".bak");
			} catch {}
			const tmp = `${CONFIG_FILE}.tmp-${process.pid}-${Date.now()}`;
			fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf8");
			fs.renameSync(tmp, CONFIG_FILE);
			return true;
		} catch (e) {
			diag(`config-write-failed: ${String(e)}`);
			return false;
		}
	}
	let cachedBalance = null;
	let cachedCurrency = "CNY";
	let lastTurnCost = null;
	let subagentRunning = 0;
	let currentSession = null;
	let lastKnownSession = null;
	function isPeakTime(timeSec) {
		if (!isFinite(timeSec)) return false;
		const bj = /* @__PURE__ */ new Date(timeSec * 1e3 + 288e5);
		const dow = bj.getUTCDay();
		if (dow === 0 || dow === 6) return false;
		const hour = bj.getUTCHours();
		return hour >= 9 && hour < 12 || hour >= 14 && hour < 18;
	}
	/** 当前时段峰谷：官方时段总是高峰或低谷。 */
	function computePeak(now) {
		return isPeakTime(Math.floor(now.getTime() / 1e3)) ? "high" : "low";
	}
	async function refreshBalance() {
		try {
			const creds = ctx.credentials ?? ctx.get("credentials");
			if (!creds) diag("refresh: no-credentials（继续走启动环境变量回退）");
			const hit = await resolveOfficialKey(creds ?? { resolve: async () => void 0 });
			if (!hit) {
				diag(`refresh: no-key，已试过 ${OFFICIAL_KEY_REFS.join(" / ")}`);
				return;
			}
			diag(`refresh: key-from ${hit.ref}`);
			const key = hit.key;
			const { totalBalance, currency } = await fetchBalance(key);
			cachedBalance = totalBalance;
			cachedCurrency = currency;
			ledger.observe(totalBalance);
			diag(`refresh-ok balance=${totalBalance} currency=${currency}`);
			try {
				fs.writeFileSync(USAGE_FILE, JSON.stringify(ledger.state));
			} catch {}
		} catch (err) {
			diag(`refresh-fail ${err?.message ?? String(err)}`);
		}
	}
	refreshBalance();
	const scheduleBalance = () => {
		const ms = widgetConfig.realtimeBalance ? 1e4 : 6e4;
		setTimeout(() => {
			refreshBalance();
			scheduleBalance();
		}, ms);
	};
	scheduleBalance();
	const subagentJobs = ctx.get("jobs");
	const recountSubagents = () => {
		try {
			const agent = ctx.agents?.roots?.()[0] ?? ctx.agents?.list?.()[0];
			if (!subagentJobs || !agent || typeof subagentJobs.list !== "function") return;
			const snaps = subagentJobs.list(agent) ?? [];
			let n = 0;
			for (const s of snaps) if (s && s.kind === "subagent" && (s.status === "running" || s.status === "stopping")) n++;
			if (n !== subagentRunning) {
				subagentRunning = n;
				diag(`subagents: ${n}`);
			}
		} catch {}
	};
	if (subagentJobs) {
		if (typeof subagentJobs.onJobsChanged === "function") subagentJobs.onJobsChanged(() => recountSubagents());
		if (typeof subagentJobs.onJobDone === "function") subagentJobs.onJobDone(() => recountSubagents());
		if (ctx.on) {
			ctx.on("subagent/start", () => recountSubagents());
			ctx.on("subagent/end", () => recountSubagents());
		}
		recountSubagents();
		setTimeout(recountSubagents, 3e3);
	}
	ctx.on("session/event", (session) => {
		if (session) currentSession = session;
	});
	let workState = "idle";
	let workStateSince = Date.now();
	let lastGrowthTotal = -1;
	let lastGrowthAt = 0;
	let lastMeasureTotal = 0;
	function setWorkState(s) {
		if (workState === s) return;
		workState = s;
		workStateSince = Date.now();
		if (s === "thinking") {
			lastGrowthTotal = -1;
			lastGrowthAt = Date.now();
		}
		diag(`workstate: ${s}`);
	}
	try {
		ctx.on("agent/inbox/inserted", () => setWorkState("thinking"));
	} catch {
		diag("workstate: agent/inbox/inserted 事件不可用");
	}
	ctx.on("agent/turn-stopping", (payload) => {
		setWorkState("done");
		try {
			const agent = payload?.agent;
			const session = agent?.session ?? (agent?.sessionId ? ctx.sessions?.get?.(agent.sessionId) : void 0);
			if (!session) return;
			currentSession = session;
			const tm = ctx.tokenMeter ?? ctx.get("tokenMeter");
			if (!tm) return;
			const m = tm.measure(session);
			const total = Number(m?.totalTokens ?? m?.tokens ?? m?.total ?? 0);
			if (total > 0) lastTurnCost = estimateCostUnsplit(total, DEEPSEEK_PRICE);
		} catch {}
	});
	function buildState() {
		let contextTokens = 0;
		try {
			const tm = ctx.tokenMeter ?? ctx.get("tokenMeter");
			const agent = ctx.agents?.roots?.()[0] ?? ctx.agents?.list?.()[0];
			const session = currentSession ?? lastKnownSession ?? agent?.session ?? ctx.sessions?.list?.()[0] ?? ctx.sessions?.get?.();
			if (session) lastKnownSession = session;
			if (tm && session) {
				const m = tm.measure(session);
				try {
					if (DEBUG) {
						diag(`measure-keys: ${Object.keys(m).join(",")}`);
						diag(`measure: ${JSON.stringify(m).slice(0, 800)}`);
					}
				} catch (e) {
					diag(`measure-err: ${String(e)}`);
				}
				contextTokens = Number(m?.surfaceTokens ?? m?.totalTokens ?? m?.tokens ?? m?.total ?? 0);
				lastMeasureTotal = Number(m?.totalTokens ?? m?.tokens ?? m?.total ?? 0);
				if (workState === "thinking") {
					if (lastMeasureTotal !== lastGrowthTotal) {
						lastGrowthTotal = lastMeasureTotal;
						lastGrowthAt = Date.now();
					} else if (lastGrowthTotal >= 0 && Date.now() - lastGrowthAt > 5e4) setWorkState("done");
				}
			} else diag(`measure: tm=${!!tm} session=${!!session}`);
		} catch {}
		const peak = computePeak(/* @__PURE__ */ new Date());
		if (DEBUG) {
			diag(`peak: ${peak}`);
			diag(`state: ctxTokens=${contextTokens} balance=${cachedBalance} currency=${cachedCurrency} todayUsage=${ledger.state.todayUsage} lastTurnCost=${lastTurnCost}`);
		}
		return {
			balance: cachedBalance,
			currency: cachedCurrency,
			todayUsage: ledger.state.todayUsage,
			contextPct: computeContextPct(contextTokens, DEFAULT_CONTEXT_LIMIT),
			contextTokens,
			contextLimit: DEFAULT_CONTEXT_LIMIT,
			lastTurnCost,
			peakLow: peak,
			refreshMs: widgetConfig.realtimeBalance ? 1e4 : 6e4,
			subagentRunning,
			sysInfo: readSys()
		};
	}
	/** 系统资源：内存（os 准确）+ CPU（loadavg 近似，避免引入笨重 sysinfo 依赖）。 */
	function readSys() {
		try {
			const total = os.totalmem();
			const used = total - os.freemem();
			const memPct = total > 0 ? Math.round(used / total * 100) : 0;
			const cpus = os.cpus();
			let cpuTotal = 0;
			let cpuIdle = 0;
			for (const c of cpus) {
				const t = c.times;
				cpuTotal += (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0);
				cpuIdle += t.idle || 0;
			}
			const cpuBusy = cpuTotal - cpuIdle;
			let cpu = 0;
			if (lastCpuTimes) {
				const dTotal = cpuTotal - lastCpuTimes.total;
				const dBusy = cpuBusy - lastCpuTimes.busy;
				if (dTotal > 0) cpu = Math.min(100, Math.round(dBusy / dTotal * 100));
			}
			lastCpuTimes = {
				total: cpuTotal,
				busy: cpuBusy
			};
			return {
				memPct,
				memUsed: Math.round(used / 1024 ** 3 * 10) / 10,
				memTotal: Math.round(total / 1024 ** 3 * 10) / 10,
				cpu
			};
		} catch {
			return {
				memPct: 0,
				memUsed: 0,
				memTotal: 0,
				cpu: 0
			};
		}
	}
	function registerApiRoutes(server) {
		safeRegister(server, {
			kind: "exact",
			path: "/dsh-whale-girl-2/api/state",
			handler: (req, res) => {
				if (DEBUG) diag("state-hit");
				res.writeHead(200, {
					"Content-Type": "application/json; charset=utf-8",
					"Cache-Control": "no-store"
				});
				res.end(JSON.stringify(buildState()));
			}
		});
		safeRegister(server, {
			kind: "exact",
			path: "/dsh-whale-girl-2/api/workstate",
			handler: (req, res) => {
				let s = workState;
				const age = Date.now() - workStateSince;
				if (s === "done" && age > 3e4) s = "idle";
				if (s === "thinking" && age > 6e5) s = "idle";
				res.writeHead(200, {
					"Content-Type": "application/json; charset=utf-8",
					"Cache-Control": "no-store"
				});
				res.end(JSON.stringify({
					state: s,
					since: workStateSince
				}));
			}
		});
		safeRegister(server, {
			kind: "exact",
			path: "/dsh-whale-girl-2/api/state.js",
			handler: (req, res) => {
				if (DEBUG) diag("state-jsonp-hit");
				res.writeHead(200, {
					"Content-Type": "text/javascript; charset=utf-8",
					"Cache-Control": "no-store"
				});
				res.end(`window.__wgState=${JSON.stringify(buildState())};`);
			}
		});
		safeRegister(server, {
			kind: "exact",
			path: "/dsh-whale-girl-2/api/config",
			handler: (req, res) => {
				const method = (req.method ?? "GET").toUpperCase();
				if (method === "POST" || method === "PUT") {
					let body = "";
					req.on("data", (c) => {
						body += String(c);
					});
					req.on("end", () => {
						let saved = false;
						try {
							widgetConfig = normalizeConfig(JSON.parse(body));
							saved = writeConfigFile(widgetConfig);
						} catch {}
						res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
						res.end(JSON.stringify({
							ok: saved,
							config: widgetConfig
						}));
					});
					return;
				}
				res.writeHead(200, {
					"Content-Type": "application/json; charset=utf-8",
					"Cache-Control": "no-store"
				});
				res.end(JSON.stringify(widgetConfig));
			}
		});
		safeRegister(server, {
			kind: "exact",
			path: "/dsh-whale-girl-2/api/diag-event",
			handler: (req, res) => {
				let body = "";
				req.on("data", (c) => {
					body += String(c);
				});
				req.on("end", () => {
					if (DEBUG || /"(click|snap)"/.test(body)) diag(`event: ${body.slice(0, 200)}`);
					res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
					res.end("{\"ok\":true}");
				});
			}
		});
		safeRegister(server, {
			kind: "exact",
			path: "/dsh-whale-girl-2/api/providers",
			handler: (req, res) => {
				(async () => {
					const creds = ctx.credentials ?? ctx.get("credentials");
					const cur = currentModel();
					const rows = await Promise.all(listProviders().map(async (p) => {
						let balance = null;
						let currency = "CNY";
						if (creds) try {
							const key = p.family === "deepseek" ? (await resolveOfficialKey(creds))?.key : unwrapCredential(await creds.resolve(p.apiKeyEnv ?? ""));
							if (key) {
								const r = await fetchProviderBalance({
									family: p.family,
									baseURL: p.baseURL
								}, key);
								if (r) {
									balance = r.totalBalance;
									currency = r.currency;
								}
							}
						} catch {}
						return {
							...p,
							balance,
							currency,
							active: p.id === cur.provider
						};
					}));
					res.writeHead(200, {
						"Content-Type": "application/json; charset=utf-8",
						"Cache-Control": "no-store"
					});
					res.end(JSON.stringify({
						providers: rows,
						current: cur
					}));
				})();
			}
		});
		safeRegister(server, {
			kind: "exact",
			path: "/dsh-whale-girl-2/api/select-model",
			handler: (req, res) => {
				let body = "";
				req.on("data", (c) => {
					body += String(c);
				});
				req.on("end", () => {
					try {
						const parsed = JSON.parse(body);
						const provider = String(parsed.provider ?? "");
						const model = String(parsed.model ?? "");
						if (!provider || !model) {
							res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
							res.end(JSON.stringify({
								ok: false,
								error: "provider and model required"
							}));
							return;
						}
						const ok = selectModel(provider, model);
						diag(`select-model ${provider}/${model} ok=${ok}`);
						res.writeHead(ok ? 200 : 500, { "Content-Type": "application/json; charset=utf-8" });
						res.end(JSON.stringify({ ok }));
					} catch {
						res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
						res.end(JSON.stringify({
							ok: false,
							error: "bad json"
						}));
					}
				});
			}
		});
	}
	const apiServer = ctx.get("webServer");
	if (apiServer) {
		registerApiRoutes(apiServer);
		const BRIDGE_JS = `(function () {
  if (window.__wgBridge) return
  window.__wgBridge = true
  var nextDelay = 60000
  var pull = function () {
    try {
      fetch('/dsh-whale-girl-2/api/state', { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (d) {
          if (d && typeof d === 'object') {
            window.__wgData = d
            window.postMessage({ __wgData: d }, '*')
          }
          if (d && typeof d.refreshMs === 'number') nextDelay = d.refreshMs
          setTimeout(pull, nextDelay)
        })
        .catch(function () { setTimeout(pull, nextDelay) })
    } catch (e) { setTimeout(pull, nextDelay) }
  }
  pull()
  // 注：pull 自调度，间隔跟随 /api/state 的 refreshMs（实时切换即时生效）
  // 工作状态：5 秒轮询并广播给挂件（读取轻量端点，不触发 measure）
  var pullWork = function () {
    try {
      fetch('/dsh-whale-girl-2/api/workstate', { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (d) {
          if (d && d.state) {
            window.__wgWorkState = d
            window.postMessage({ __wgWorkState: d }, '*')
          }
        })
        .catch(function () {})
    } catch (e) {}
  }
  pullWork()
  setInterval(pullWork, 5000)
  // 交互诊断回流：slots 挂件触发交互时 postMessage 事件，此处接收并上报宿主写日志
  window.addEventListener('message', function (ev) {
    var d = ev.data
    if (d && d.__wgEvent) {
      try {
        fetch('/dsh-whale-girl-2/api/diag-event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(d.__wgEvent)
        }).catch(function () {})
      } catch (err) {}
    }
  })
})()`;
		ctx.on("webserver/index-inject", (table) => {
			if (!(Array.isArray(table) && table.some((row) => row && typeof row === "object" && typeof row.text === "string" && row.text.indexOf("__wgBridge") !== -1))) {
				diag("index-inject-called");
				table.push({
					kind: "script",
					placement: "head",
					text: BRIDGE_JS
				});
			}
		});
		if (apiServer && typeof apiServer.tapIndex === "function") apiServer.tapIndex((html) => {
			if (html.indexOf("__wgBridge") !== -1) return html;
			diag("tap-index-called");
			return html.replace("</head>", "<script>" + BRIDGE_JS + "<\/script></head>");
		});
	}
}
//#endregion
export { apply, inject, name };

//# sourceMappingURL=index.js.map