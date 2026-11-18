// Farm-first token radar (zech-radar-v2): every protocol is scored from the snapshot's own
// figures, then handed a concrete farm plan. The ranking is the model's claim, never a promise.
//
// Implied value (one function, no protocol name ever special-cased):
//   base       = tvl_usd x 0.30
//   growthMult = 1 + clamp(change_7d, -50, 150) / 100 x 0.65
//   tenureMult = 0.55 + min(age_days, 1460) / 1460 x 0.45   (age unknown: 365 days)
//   chainMult  = 1 + 0.02 x min(chains, 5)
//   implied    = round(base x growthMult x tenureMult x chainMult)
//
// Farm-first angle: the plan is the hero. Each protocol gets a 7-step plan built from its
// category, its chains and its TVL tier: a specific on-chain action, a capital size, a gas
// estimate per step (priced per chain), a hold window, and an airdrop-readiness score
// (0-100) plus a risk label derived from age, growth and category.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export const MODEL = {
  base_multiple: 0.3,
  growth_weight: 0.65,
  growth_floor: -50,
  growth_cap: 150,
  tenure_floor: 0.55,
  tenure_range: 0.45,
  tenure_days: 1460,
  unknown_age_days: 365,
  chain_step: 0.02,
  chain_cap: 5,
};
export const MODEL_VERSION = 'farm-first-2';
export const EARLY_ROWS = 240;
export const LIVE_ROWS = 24;

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  readiness: number;
  risk: 'Low' | 'Medium' | 'High';
  capital_usd: number;
  hold_days: number;
  est_gas_usd: number;
  model: { base_multiple: number; growth_pct: number; growth_multiplier: number; tenure_multiplier: number; chain_multiplier: number; age_days: number | null };
  farm_steps: string[];
}

export interface RadarRow {
  rank: number; slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null; listed_at: string | null;
  age_days: number | null; implied_value_usd: number; readiness: number; risk: string;
  capital_usd: number; hold_days: number; est_gas_usd: number;
  growth_multiplier: number; tenure_multiplier: number; chain_multiplier: number;
  farm_steps: string[];
}

export interface LiveRow { slug: string; name: string; category: string | null; chains: string[]; tvl_usd: number; mcap_usd: number | null; change_7d: number | null; }

export interface RadarData {
  as_of: string; source: string; floor_usd: number; model: typeof MODEL; model_version: string;
  watchlist_size: number; board_size: number; early_size: number; live_size: number;
  rows: RadarRow[]; live: LiveRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) { super(message); this.name = 'SnapshotError'; }
}

const DAY_MS = 86_400_000;
const finite = (v: unknown, fb: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

export function impliedValue(p: SnapshotProtocol, asOf: string): { implied: number; growthPct: number; growthMult: number; tenureMult: number; chainMult: number; age: number | null } {
  const age = ageDays(asOf, p.listed_at);
  const growthPct = Math.min(MODEL.growth_cap, Math.max(MODEL.growth_floor, finite(p.change_7d, 0)));
  const growthMult = 1 + (growthPct / 100) * MODEL.growth_weight;
  const ageForModel = age ?? MODEL.unknown_age_days;
  const tenureMult = MODEL.tenure_floor + (Math.min(Math.max(ageForModel, 0), MODEL.tenure_days) / MODEL.tenure_days) * MODEL.tenure_range;
  const chainMult = 1 + MODEL.chain_step * Math.min(p.chains.length, MODEL.chain_cap);
  const implied = Math.max(1, Math.round(p.tvl_usd * MODEL.base_multiple * growthMult * tenureMult * chainMult));
  return { implied, growthPct, growthMult, tenureMult, chainMult, age };
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
export function isPreToken(p: SnapshotProtocol): boolean { return p.mcap_usd === null && p.gecko_id === null && p.symbol === null; }
export function isRankable(p: SnapshotProtocol): boolean { return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name); }

/** Gas price tier of a chain, in USD per ordinary transaction (fee levels, not a live quote). */
export function gasPerTx(chain: string): number {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 8;
  if (c === 'solana') return 0.05;
  if (c === 'binance' || c === 'polygon' || c === 'avalanche' || c === 'tron') return 0.3;
  if (c === 'bitcoin' || c === 'lightning network') return 3;
  return 1.5; // most L2s and app-chains
}

export function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

export function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  if (age < 730) return 30;
  return 21;
}

/** Airdrop readiness 0-100: tenure + scale + momentum + chain breadth, all from the snapshot. */
export function readinessFor(p: SnapshotProtocol, age: number | null): number {
  const ageScore = age === null ? 12 : Math.min(30, Math.round((age / 1460) * 30));
  const tvlScore = p.tvl_usd >= 1e9 ? 30 : p.tvl_usd >= 1e8 ? 24 : p.tvl_usd >= 5e7 ? 18 : 10;
  const g = finite(p.change_7d, 0);
  const growthScore = g >= 20 ? 25 : g >= 5 ? 20 : g >= 0 ? 15 : g >= -10 ? 10 : 5;
  const chainScore = Math.min(15, p.chains.length * 3);
  return Math.max(5, Math.min(98, ageScore + tvlScore + growthScore + chainScore));
}

/** Risk label from age, momentum and category risk (young + shrinking + leveraged = High). */
export function riskFor(p: SnapshotProtocol, age: number | null): 'Low' | 'Medium' | 'High' {
  const c = (p.category ?? '').toLowerCase();
  let score = 0;
  if (age === null || age < 180) score += 2; else if (age < 365) score += 1;
  const g = finite(p.change_7d, 0);
  if (g < -20) score += 2; else if (g < -5) score += 1;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('leveraged')) score += 1;
  if (p.tvl_usd < 50_000_000) score += 1;
  return score >= 4 ? 'High' : score >= 2 ? 'Medium' : 'Low';
}

function chainOf(p: SnapshotProtocol): string { return p.chains.length > 0 ? p.chains[0]! : 'its main chain'; }
function money(n: number): string { return n % 1 === 0 ? `$${n}` : `$${n.toFixed(2)}`; }

/** The category-specific core farming action, in words a farmer can follow on-chain. */
function coreAction(p: SnapshotProtocol, capital: number, chain: string): { action: string; second: string } {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return {
    action: `Supply ${money(capital)} of USDC to ${n} on ${chain}, then borrow $10 of USDC against it and repay it the same week so both sides of the market are used.`,
    second: `Open a second, smaller supply position in a different asset on ${n} and leave it open for the full hold window.`,
  };
  if (c.includes('dex')) return {
    action: `Add ${money(capital)} of liquidity to ${n}'s highest-TVL pool on ${chain} (a stable pair if one exists) and keep the LP position open.`,
    second: `Swap $25 through ${n} on ${chain} once a week, rotating the pair each time, and collect any trading fees the position earns.`,
  };
  if (c.includes('liquid staking') || c.includes('restak')) return {
    action: `Stake ${money(capital)} of the chain's native staking asset through ${n} on ${chain} and hold the liquid receipt token in the same wallet.`,
    second: `Use the receipt token once in a lending or LP position on ${chain} so the wallet shows both staking and DeFi use.`,
  };
  if (c.includes('bridge') || c.includes('canonical bridge')) return {
    action: `Bridge ${money(capital)} of USDC into ${chain} through ${n}, then deploy the bridged funds in one on-chain app on the destination chain the same day.`,
    second: `Bridge a $25 return leg back through ${n} the following week so the wallet shows two-way bridge volume.`,
  };
  if (c.includes('perpetual') || c.includes('derivative')) return {
    action: `Deposit ${money(capital)} of USDC as margin on ${n} on ${chain}, open one small long with 2x leverage or less, and close it within 48 hours.`,
    second: `Place one small limit order on ${n} each week and let it fill or cancel it, keeping total exposure under ${money(capital)}.`,
  };
  if (c.includes('yield aggregator') || c.includes('yield')) return {
    action: `Deposit ${money(capital)} of USDC into ${n}'s flagship vault on ${chain} and let the yield compound without withdrawing.`,
    second: `Harvest or claim the vault's rewards once, then re-deposit the harvest so the wallet shows a full deposit-harvest cycle.`,
  };
  if (c.includes('curator') || c.includes('allocator') || c.includes('risk curator')) return {
    action: `Deposit ${money(capital)} into a ${n} curated vault on ${chain} and hold the vault shares for the full hold window.`,
    second: `Split a $25 top-up into a second ${n} vault on ${chain} so the wallet touches two curators, not one.`,
  };
  if (c.includes('stable')) return {
    action: `Mint ${money(capital)} of the stable asset through ${n} on ${chain} with USDC collateral and hold the minted stablecoin.`,
    second: `Provide $25 of the minted stablecoin to a stability or savings pool on ${chain} for at least two weeks.`,
  };
  if (c.includes('rwa')) return {
    action: `Mint ${money(capital)} of the yield-bearing asset on ${n} on ${chain} and hold it in the farming wallet for the full hold window.`,
    second: `Reinvest one yield payout from ${n} back into the same asset instead of withdrawing it to the exchange.`,
  };
  if (c.includes('prediction')) return {
    action: `Fund ${money(capital)} on ${n} and place one small position on a market that settles within two weeks, risking at most $25 of it.`,
    second: `Place a second position on a different ${n} market the following week so the wallet shows repeat participation.`,
  };
  if (c.includes('insurance')) return {
    action: `Buy ${money(capital)} of cover from ${n} on ${chain} for a protocol you already use, and keep the policy active for the full hold window.`,
    second: `Renew or extend the cover once before it lapses so the wallet shows a second insurance purchase.`,
  };
  if (c.includes('staking')) return {
    action: `Stake ${money(capital)} of the chain's staking asset through ${n} on ${chain} and keep the stake receipt in the farming wallet.`,
    second: `Claim staking rewards once and re-stake them through ${n} instead of sending them to an exchange.`,
  };
  return {
    action: `Deposit ${money(capital)} of USDC into ${n} on ${chain} and keep the position open for the full hold window.`,
    second: `Make one extra on-chain action on ${n} each week — a swap, a deposit top-up or a vote — so the wallet stays active.`,
  };
}

/** One step as a single string: action + cost + time, inside the gate's 20..600 characters. */
function stepText(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep the position open and check the protocol's own page.`;
  return s;
}

/**
 * The farm-first plan: 7 steps. Step 1 sets the wallet up, step 2 is the core on-chain action,
 * step 3 a second qualifying action, step 4 the weekly cadence, step 5 the hold + readiness check,
 * step 6 the claim-safety rule, step 7 the exit and the log. Every figure comes from the
 * protocol's own record (category, chains, TVL tier, age) — never from a hand-written list.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasPerTx(chain);
  const { action, second } = coreAction(p, capital, chain);
  const ready = readinessFor(p, age);
  const risk = riskFor(p, age);
  return [
    stepText(`Set up a fresh wallet that holds only the ${money(capital)} you plan to farm on ${chain}, keep its seed phrase offline, and fund it with ${money(Math.ceil(gas * 6))} extra for gas.`, `${money(Math.ceil(gas * 6))} of gas reserve, no deposit yet`, '10 minutes'),
    stepText(action, `${money(capital)} of capital plus about ${money(gas * 2)} of gas`, '15 minutes to set up'),
    stepText(second, `about ${money(gas * 2)} of gas`, '10 minutes'),
    stepText(`Repeat one qualifying action on ${p.name} every week — a swap, a top-up, a borrow or a vote — for ${Math.ceil(hold / 7)} weeks, and never let the wallet sit idle for a full snapshot window.`, `about ${money(gas)} of gas a week`, '10 minutes a week'),
    stepText(`Hold the position for at least ${hold} days. ${p.name} scores ${ready}/100 on airdrop readiness with ${risk} risk, so treat the hold as the qualifying window, not a lock-up: you can exit any time.`, `the ${money(capital)} stays in the position`, `${hold} days`),
    stepText(`Check eligibility only on ${p.name}'s own points or rewards page, reached from its official site. Never pay to claim, never sign a permit or an unlimited approval to claim, and ignore claim links from chats or DMs.`, 'no fee to check', '10 minutes'),
    stepText(`When a token launches, claim from the official page, sell or hold by your own plan, then revoke the approvals you no longer need and write the wallet, dates and every transaction hash in a farm log.`, `about ${money(gas)} of gas to revoke`, '15 minutes'),
  ];
}

export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) { const p = index.get(slug); if (p) chosen.set(slug, p); }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);
  const scored = [...chosen.values()].map((p) => ({ p, ...impliedValue(p, snapshot.as_of) }));
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => {
    const capital = capitalFor(s.p);
    const hold = holdDaysFor(s.age);
    const gas = gasPerTx(chainOf(s.p));
    return {
      rank: i + 1, slug: s.p.slug, name: s.p.name, category: s.p.category, chains: s.p.chains,
      tvl_usd: s.p.tvl_usd, change_7d: s.p.change_7d, mcap_usd: s.p.mcap_usd, listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id, symbol: s.p.symbol, token_status: 'pre-token' as const, age_days: s.age,
      implied_value_usd: s.implied, readiness: readinessFor(s.p, s.age), risk: riskFor(s.p, s.age),
      capital_usd: capital, hold_days: hold, est_gas_usd: Math.round(gas * 8 * 100) / 100,
      model: { base_multiple: MODEL.base_multiple, growth_pct: s.growthPct, growth_multiplier: round4(s.growthMult), tenure_multiplier: round4(s.tenureMult), chain_multiplier: round4(s.chainMult), age_days: s.age },
      farm_steps: farmSteps(s.p, s.age),
    };
  });
}

export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d }));
}

export function radarRow(r: BoardRow): RadarRow {
  return { rank: r.rank, slug: r.slug, name: r.name, category: r.category, chains: r.chains, tvl_usd: r.tvl_usd, change_7d: r.change_7d, mcap_usd: r.mcap_usd, listed_at: r.listed_at, age_days: r.age_days, implied_value_usd: r.implied_value_usd, readiness: r.readiness, risk: r.risk, capital_usd: r.capital_usd, hold_days: r.hold_days, est_gas_usd: r.est_gas_usd, growth_multiplier: r.model.growth_multiplier, tenure_multiplier: r.model.tenure_multiplier, chain_multiplier: r.model.chain_multiplier, farm_steps: r.farm_steps };
}

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = { as_of: snapshot.as_of, source: snapshot.source, floor_usd: snapshot.floor_usd, model: MODEL, model_version: MODEL_VERSION, watchlist_size: snapshot.watchlist.length, board_size: board.length, early_size: early, live_size: live.length, rows: board.map(radarRow), live };
  return { board, radar };
}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new SnapshotError('snapshot.json is not JSON'); }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    return {
      slug: p.slug, name: p.name, category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) return 'all rows share the same implied value';
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

export function dataScript(radar: RadarData): string { return `window.RADAR=${JSON.stringify(radar)};\n`; }
