import Groq from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || process.env.NEXT_PUBLIC_GROQ_API_KEY });

// Local types for SEO tracking to avoid clashing with DB schema types
export type Pillar = 'seo' | 'social' | 'pricing' | 'advertising' | 'timeline' | 'ai_insights';

export interface RankSnapshot {
  keyword: string;
  domain: string;
  position: number | null;
  capturedAt: string;
}

export interface ContentPage {
  url: string;
  title: string;
  topics: string[];
}

export interface Backlink {
  domain: string;
  referringDomain: string;
  domainAuthority: number;
  firstSeen: string;
}

export interface SeoChangeEvent {
  competitorId: string;
  pillar: Pillar;
  field: string;
  oldValue: any;
  newValue: any;
  diffSummary: string;
  detectedAt: string;
  rawRefs: Record<string, any>;
}

// ---------- 1. Collection ----------

export interface SeoProviderClient {
  getRankings(domain: string, keywords: string[]): Promise<{ keyword: string; position: number | null }[]>;
  getTopRankingPages(domain: string, limit: number): Promise<{ url: string; title: string }[]>;
  getBacklinks(domain: string): Promise<{ referringDomain: string; domainAuthority: number }[]>;
}

export class DataForSeoClient implements SeoProviderClient {
  constructor(private apiKey: string) {}

  async getRankings(domain: string, keywords: string[]) {
    const response = await fetch('https://api.dataforseo.com/v3/serp/google/organic/live/advanced', {
      method: 'POST',
      headers: { Authorization: `Basic ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(keywords.map((keyword) => ({ keyword, target: domain, language_code: 'en' }))),
    });
    const data = await response.json();
    return keywords.map((keyword, i) => ({
      keyword,
      position: data.tasks?.[i]?.result?.[0]?.items?.find((it: any) => it.domain === domain)?.rank_absolute ?? null,
    }));
  }

  async getTopRankingPages(domain: string, limit: number) {
    const response = await fetch('https://api.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live', {
      method: 'POST',
      headers: { Authorization: `Basic ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ target: domain, limit, order_by: ['keyword_data.keyword_info.search_volume,desc'] }]),
    });
    const data = await response.json();
    const items = data.tasks?.[0]?.result?.[0]?.items ?? [];

    const seen = new Map<string, { url: string; title: string }>();
    for (const item of items) {
      const url = item.ranked_serp_element?.serp_item?.url;
      const title = item.ranked_serp_element?.serp_item?.title;
      if (url && !seen.has(url)) seen.set(url, { url, title: title ?? '' });
    }
    return [...seen.values()];
  }

  async getBacklinks(domain: string) {
    const response = await fetch('https://api.dataforseo.com/v3/backlinks/referring_domains/live', {
      method: 'POST',
      headers: { Authorization: `Basic ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ target: domain, limit: 100, order_by: ['rank,desc'] }]),
    });
    const data = await response.json();
    const items = data.tasks?.[0]?.result?.[0]?.items ?? [];
    return items.map((it: any) => ({ referringDomain: it.domain, domainAuthority: it.rank ?? 0 }));
  }
}

export function batchKeywords(keywords: string[], batchSize = 100): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < keywords.length; i += batchSize) {
    batches.push(keywords.slice(i, i + batchSize));
  }
  return batches;
}

export async function trackRankings(
  client: SeoProviderClient,
  domains: string[],
  keywords: string[]
): Promise<RankSnapshot[]> {
  const capturedAt = new Date().toISOString();
  const snapshots: RankSnapshot[] = [];

  for (const domain of domains) {
    for (const batch of batchKeywords(keywords)) {
      const rankings = await client.getRankings(domain, batch);
      for (const r of rankings) {
        snapshots.push({ keyword: r.keyword, domain, position: r.position, capturedAt });
      }
    }
  }
  return snapshots;
}

// ---------- 2. Delta / Boundary-Crossing Detection ----------

export interface RankDelta {
  keyword: string;
  domain: string;
  previousPosition: number | null;
  currentPosition: number | null;
  delta: number | null; 
}

export function computeRankDeltas(previous: RankSnapshot[], current: RankSnapshot[]): RankDelta[] {
  return current.map((curr) => {
    const prev = previous.find((p) => p.keyword === curr.keyword && p.domain === curr.domain);
    const delta =
      prev?.position != null && curr.position != null ? prev.position - curr.position : null;
    return {
      keyword: curr.keyword,
      domain: curr.domain,
      previousPosition: prev?.position ?? null,
      currentPosition: curr.position,
      delta,
    };
  });
}

export interface BoundaryCrossing {
  keyword: string;
  domain: string;
  boundary: 3 | 10 | 20;
  direction: 'entered' | 'exited';
  previousPosition: number | null;
  currentPosition: number | null;
}

const BOUNDARIES = [3, 10, 20] as const;

export function detectBoundaryCrossings(deltas: RankDelta[]): BoundaryCrossing[] {
  const crossings: BoundaryCrossing[] = [];

  for (const d of deltas) {
    for (const boundary of BOUNDARIES) {
      const wasAbove = d.previousPosition != null && d.previousPosition <= boundary;
      const isAbove = d.currentPosition != null && d.currentPosition <= boundary;

      if (!wasAbove && isAbove) {
        crossings.push({ keyword: d.keyword, domain: d.domain, boundary, direction: 'entered', previousPosition: d.previousPosition, currentPosition: d.currentPosition });
      } else if (wasAbove && !isAbove) {
        crossings.push({ keyword: d.keyword, domain: d.domain, boundary, direction: 'exited', previousPosition: d.previousPosition, currentPosition: d.currentPosition });
      }
    }
  }

  return dedupeToTightestBoundary(crossings);
}

function dedupeToTightestBoundary(crossings: BoundaryCrossing[]): BoundaryCrossing[] {
  const byKeywordDomain = new Map<string, BoundaryCrossing>();
  for (const c of crossings) {
    const key = `${c.keyword}::${c.domain}::${c.direction}`;
    const existing = byKeywordDomain.get(key);
    if (!existing || c.boundary < existing.boundary) byKeywordDomain.set(key, c);
  }
  return [...byKeywordDomain.values()];
}

// ---------- 3. Keyword Gap Analysis ----------

export interface KeywordGap {
  keyword: string;
  competitorDomain: string;
  competitorPosition: number;
}

export function computeKeywordGaps(userDomain: string, snapshots: RankSnapshot[]): KeywordGap[] {
  const byKeyword = groupBy(snapshots, (s) => s.keyword);
  const gaps: KeywordGap[] = [];

  for (const entries of Object.values(byKeyword)) {
    const keyword = entries[0].keyword;
    const userEntry = entries.find((e) => e.domain === userDomain);
    const userRanksWell = userEntry?.position != null && userEntry.position <= 50;
    if (userRanksWell) continue;

    for (const entry of entries) {
      if (entry.domain !== userDomain && entry.position != null && entry.position <= 20) {
        gaps.push({ keyword, competitorDomain: entry.domain, competitorPosition: entry.position });
      }
    }
  }
  return gaps.sort((a, b) => a.competitorPosition - b.competitorPosition);
}

// ---------- 4. Content Gap Analysis ----------

const TOPIC_TAGGING_PROMPT = `Given this page title and URL, output 1-3 short topic tags (2-4 words each)
that describe what this page is about. Respond with ONLY a JSON array of strings, no other text.

Title: {{TITLE}}
URL: {{URL}}`;

export async function tagPageTopics(page: { url: string; title: string }): Promise<string[]> {
  try {
    const response = await groq.chat.completions.create({
      model: 'llama3-8b-8192', 
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: TOPIC_TAGGING_PROMPT.replace('{{TITLE}}', page.title).replace('{{URL}}', page.url),
      }],
    });

    const text = response.choices[0]?.message?.content;
    if (!text) return [];

    const tags = JSON.parse(text.trim().replace(/^```json\n?/, '').replace(/```$/, ''));
    return Array.isArray(tags) ? tags.map((t) => String(t).toLowerCase()) : [];
  } catch (err) {
    console.error('Failed to tag page topics with Groq', err);
    return []; 
  }
}

export async function buildContentInventory(
  client: SeoProviderClient,
  domain: string,
  limit = 50
): Promise<ContentPage[]> {
  const pages = await client.getTopRankingPages(domain, limit);
  return Promise.all(pages.map(async (p) => ({ ...p, topics: await tagPageTopics(p) })));
}

export interface ContentGap {
  topic: string;
  competitorDomain: string;
  competitorPage: ContentPage;
}

export function computeContentGaps(
  userPages: ContentPage[],
  competitorDomain: string,
  competitorPages: ContentPage[]
): ContentGap[] {
  const userTopics = new Set(userPages.flatMap((p) => p.topics));
  const gaps: ContentGap[] = [];

  for (const page of competitorPages) {
    for (const topic of page.topics) {
      if (!userTopics.has(topic)) gaps.push({ topic, competitorDomain, competitorPage: page });
    }
  }
  return gaps;
}

// ---------- 5. Backlink Monitoring ----------

export async function fetchBacklinks(client: SeoProviderClient, domain: string): Promise<Backlink[]> {
  const raw = await client.getBacklinks(domain);
  const firstSeen = new Date().toISOString();
  return raw.map((b) => ({ domain, referringDomain: b.referringDomain, domainAuthority: b.domainAuthority, firstSeen }));
}

export function detectNewHighAuthorityBacklinks(
  previous: Backlink[],
  current: Backlink[],
  authorityThreshold = 50
): Backlink[] {
  const knownDomains = new Set(previous.map((b) => b.referringDomain));
  return current.filter((b) => !knownDomains.has(b.referringDomain) && b.domainAuthority >= authorityThreshold);
}

// ---------- 6. Emit Change Events ----------

export function buildSeoChangeEvents(
  competitorId: string,
  input: { boundaryCrossings: BoundaryCrossing[]; contentGaps: ContentGap[]; newBacklinks: Backlink[] }
): SeoChangeEvent[] {
  const now = new Date().toISOString();
  const events: SeoChangeEvent[] = [];

  for (const crossing of input.boundaryCrossings) {
    events.push({
      competitorId,
      pillar: 'seo' as Pillar,
      field: crossing.keyword,
      oldValue: { position: crossing.previousPosition },
      newValue: { position: crossing.currentPosition, boundary: crossing.boundary, direction: crossing.direction },
      diffSummary: `${crossing.domain} ${crossing.direction} top ${crossing.boundary} for "${crossing.keyword}" (${crossing.previousPosition ?? 'unranked'} → ${crossing.currentPosition ?? 'unranked'})`,
      detectedAt: now,
      rawRefs: {},
    });
  }

  for (const gap of input.contentGaps.slice(0, 10)) {
    events.push({
      competitorId,
      pillar: 'seo' as Pillar,
      field: `content_gap:${gap.topic}`,
      oldValue: null,
      newValue: { topic: gap.topic, competitorPage: gap.competitorPage.url },
      diffSummary: `${gap.competitorDomain} covers "${gap.topic}" — no equivalent page found on your site`,
      detectedAt: now,
      rawRefs: {},
    });
  }

  for (const link of input.newBacklinks) {
    events.push({
      competitorId,
      pillar: 'seo' as Pillar,
      field: `backlink:${link.referringDomain}`,
      oldValue: null,
      newValue: { referringDomain: link.referringDomain, domainAuthority: link.domainAuthority },
      diffSummary: `New high-authority backlink from ${link.referringDomain} (authority ${link.domainAuthority})`,
      detectedAt: now,
      rawRefs: {},
    });
  }

  return events;
}

// ---------- Orchestration ----------

export interface SeoMonitoringConfig {
  competitorId: string;
  userDomain: string;
  competitorDomain: string;
  keywords: string[];
}

export async function runSeoMonitoringCycle(
  client: SeoProviderClient,
  config: SeoMonitoringConfig,
  previousSnapshots: RankSnapshot[],
  previousBacklinks: Backlink[],
  userContentInventory: ContentPage[]
) {
  const currentSnapshots = await trackRankings(client, [config.userDomain, config.competitorDomain], config.keywords);
  const deltas = computeRankDeltas(previousSnapshots, currentSnapshots);
  const boundaryCrossings = detectBoundaryCrossings(deltas).filter((c) => c.domain === config.competitorDomain);

  const keywordGaps = computeKeywordGaps(config.userDomain, currentSnapshots);

  const competitorPages = await buildContentInventory(client, config.competitorDomain);
  const contentGaps = computeContentGaps(userContentInventory, config.competitorDomain, competitorPages);

  const currentBacklinks = await fetchBacklinks(client, config.competitorDomain);
  const newBacklinks = detectNewHighAuthorityBacklinks(previousBacklinks, currentBacklinks);

  const changeEvents = buildSeoChangeEvents(config.competitorId, { boundaryCrossings, contentGaps, newBacklinks });

  return { currentSnapshots, keywordGaps, contentGaps, currentBacklinks, changeEvents };
}

// ---------- Helpers ----------

function groupBy<T, K extends string>(items: T[], keyFn: (item: T) => K): Record<K, T[]> {
  return items.reduce((acc, item) => {
    const key = keyFn(item);
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {} as Record<K, T[]>);
}
