import Groq from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || process.env.NEXT_PUBLIC_GROQ_API_KEY });

// Local types to avoid clashing with global DB schema
export type Pillar = 'seo' | 'social' | 'pricing' | 'advertising' | 'timeline' | 'ai_insights';

export interface SocialPost {
  id: string;
  platform: string;
  text: string;
  likes: number;
  comments: number;
  shares: number;
  postedAt: string;
}

export interface SocialChangeEvent {
  competitorId: string;
  pillar: Pillar;
  field: string;
  oldValue: any;
  newValue: any;
  diffSummary: string;
  detectedAt: string;
  rawRefs: Record<string, any>;
}

// ---------- Collection ----------

export interface SocialDataProvider {
  getFollowerCount(handle: string): Promise<number>;
  getRecentPosts(handle: string, since: Date): Promise<SocialPost[]>;
}

export class InstagramBusinessDiscoveryClient implements SocialDataProvider {
  constructor(private ownIgUserId: string, private accessToken: string, private apiVersion = 'v22.0') {}

  async getFollowerCount(handle: string): Promise<number> {
    const url = new URL(`https://graph.facebook.com/${this.apiVersion}/${this.ownIgUserId}`);
    url.searchParams.set('fields', `business_discovery.username(${handle}){followers_count}`);
    url.searchParams.set('access_token', this.accessToken);

    const data = await fetch(url.toString()).then((r) => r.json());
    if (data.error) throw new Error(`Business Discovery error: ${data.error.message}`);
    return data.business_discovery?.followers_count ?? 0;
  }

  async getRecentPosts(handle: string, since: Date): Promise<SocialPost[]> {
    const url = new URL(`https://graph.facebook.com/${this.apiVersion}/${this.ownIgUserId}`);
    url.searchParams.set(
      'fields',
      `business_discovery.username(${handle}){media.limit(25){caption,like_count,comments_count,timestamp}}`
    );
    url.searchParams.set('access_token', this.accessToken);

    const data = await fetch(url.toString()).then((r) => r.json());
    if (data.error) throw new Error(`Business Discovery error: ${data.error.message}`);

    const media = data.business_discovery?.media?.data ?? [];
    return media
      .filter((m: any) => new Date(m.timestamp) >= since)
      .map((m: any) => ({
        id: `ig_${handle}_${m.timestamp}`,
        platform: 'instagram',
        text: m.caption ?? '',
        likes: m.like_count ?? 0,
        comments: m.comments_count ?? 0,
        shares: 0, 
        postedAt: m.timestamp,
      }));
  }
}

export class FacebookPageClient implements SocialDataProvider {
  constructor(private accessToken: string, private apiVersion = 'v25.0') {}

  async getFollowerCount(pageId: string): Promise<number> {
    const url = new URL(`https://graph.facebook.com/${this.apiVersion}/${pageId}`);
    url.searchParams.set('fields', 'followers_count');
    url.searchParams.set('access_token', this.accessToken);

    const data = await fetch(url.toString()).then((r) => r.json());
    if (data.error) throw new Error(`Page API error: ${data.error.message}`);
    return data.followers_count ?? 0;
  }

  async getRecentPosts(pageId: string, since: Date): Promise<SocialPost[]> {
    const url = new URL(`https://graph.facebook.com/${this.apiVersion}/${pageId}/posts`);
    url.searchParams.set('fields', 'message,created_time,likes.summary(true),comments.summary(true),shares');
    url.searchParams.set('since', Math.floor(since.getTime() / 1000).toString());
    url.searchParams.set('access_token', this.accessToken);

    const data = await fetch(url.toString()).then((r) => r.json());
    if (data.error) throw new Error(`Page API error: ${data.error.message}`);

    return (data.data ?? []).map((p: any) => ({
      id: `fb_${p.id}`,
      platform: 'facebook',
      text: p.message ?? '',
      likes: p.likes?.summary?.total_count ?? 0,
      comments: p.comments?.summary?.total_count ?? 0,
      shares: p.shares?.count ?? 0,
      postedAt: p.created_time,
    }));
  }
}

export class ThirdPartyAggregatorClient implements SocialDataProvider {
  constructor(private apiKey: string, private baseUrl: string, private platform: 'x' | 'linkedin') {}

  async getFollowerCount(handle: string): Promise<number> {
    const response = await fetch(`${this.baseUrl}/profiles/${this.platform}/${handle}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    const data = await response.json();
    return data.followerCount ?? 0;
  }

  async getRecentPosts(handle: string, since: Date): Promise<SocialPost[]> {
    const response = await fetch(
      `${this.baseUrl}/posts/${this.platform}/${handle}?since=${since.toISOString()}`,
      { headers: { Authorization: `Bearer ${this.apiKey}` } }
    );
    const data = await response.json();
    return (data.posts ?? []).map((p: any) => ({
      id: `${this.platform}_${p.id}`,
      platform: this.platform,
      text: p.text ?? p.caption ?? '',
      likes: p.likeCount ?? 0,
      comments: p.commentCount ?? 0,
      shares: p.shareCount ?? p.repostCount ?? 0,
      postedAt: p.createdAt,
    }));
  }
}

// ---------- Engagement & Top Posts ----------

export function computeEngagementRate(post: SocialPost, followers: number): number {
  if (followers === 0) return 0;
  return (post.likes + post.comments + post.shares) / followers;
}

export function topPostsByEngagement(posts: SocialPost[], followers: number, limit = 5): SocialPost[] {
  return [...posts]
    .sort((a, b) => computeEngagementRate(b, followers) - computeEngagementRate(a, followers))
    .slice(0, limit);
}

// ---------- Anomaly Detection ----------

export function detectAnomaly(
  history: number[],
  newValue: number,
  windowSize = 14,
  threshold = 2.5
): { isAnomaly: boolean; zScore: number } {
  const window = history.slice(-windowSize);
  if (window.length < 5) return { isAnomaly: false, zScore: 0 }; 

  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return { isAnomaly: newValue !== mean, zScore: 0 };

  const zScore = (newValue - mean) / stdDev;
  return { isAnomaly: Math.abs(zScore) > threshold, zScore };
}

// ---------- Campaign/Theme Detection ----------

export function detectCampaignBursts(
  posts: SocialPost[],
  windowHours = 48,
  minPosts = 3
): { hashtag: string; postCount: number; posts: SocialPost[] }[] {
  const hashtagGroups = new Map<string, SocialPost[]>();

  for (const post of posts) {
    const hashtags = (post.text.match(/#\w+/g) ?? []).map((h) => h.toLowerCase());
    for (const tag of hashtags) {
      if (!hashtagGroups.has(tag)) hashtagGroups.set(tag, []);
      hashtagGroups.get(tag)!.push(post);
    }
  }

  const bursts: { hashtag: string; postCount: number; posts: SocialPost[] }[] = [];

  for (const [hashtag, tagged] of hashtagGroups) {
    const sorted = tagged.sort((a, b) => +new Date(a.postedAt) - +new Date(b.postedAt));
    for (let i = 0; i <= sorted.length - minPosts; i++) {
      const windowStart = +new Date(sorted[i].postedAt);
      const windowEnd = windowStart + windowHours * 60 * 60 * 1000;
      const inWindow = sorted.filter(
        (p) => +new Date(p.postedAt) >= windowStart && +new Date(p.postedAt) <= windowEnd
      );
      if (inWindow.length >= minPosts) {
        bursts.push({ hashtag, postCount: inWindow.length, posts: inWindow });
        break; 
      }
    }
  }
  return bursts;
}

// ---------- Sentiment Analysis ----------

const SENTIMENT_PROMPT = `Classify the overall sentiment of these social media comments as one of:
positive, negative, mixed, neutral.
Respond with ONLY the single word, no other text.

Comments:
{{COMMENTS}}`;

export async function analyzeSentiment(comments: string[]): Promise<'positive' | 'negative' | 'mixed' | 'neutral'> {
  if (comments.length === 0) return 'neutral';

  try {
    const response = await groq.chat.completions.create({
      model: 'llama3-8b-8192',
      messages: [{ role: 'user', content: SENTIMENT_PROMPT.replace('{{COMMENTS}}', comments.slice(0, 30).join('\n')) }],
      max_tokens: 10,
    });

    const result = response.choices[0]?.message?.content?.trim().toLowerCase();
    const valid = ['positive', 'negative', 'mixed', 'neutral'];
    return (valid.includes(result ?? '') ? result : 'neutral') as 'positive' | 'negative' | 'mixed' | 'neutral';
  } catch (err) {
    console.error('Sentiment analysis failed', err);
    return 'neutral';
  }
}

// ---------- Emit Change Events ----------

export function buildSocialChangeEvents(
  competitorId: string,
  input: {
    followerAnomaly?: { isAnomaly: boolean; zScore: number; platform: string; newValue: number };
    campaignBursts: { hashtag: string; postCount: number; platform: string }[];
  }
): SocialChangeEvent[] {
  const now = new Date().toISOString();
  const events: SocialChangeEvent[] = [];

  if (input.followerAnomaly?.isAnomaly) {
    events.push({
      competitorId,
      pillar: 'social' as Pillar,
      field: `followers:${input.followerAnomaly.platform}`,
      oldValue: null,
      newValue: { followers: input.followerAnomaly.newValue, zScore: input.followerAnomaly.zScore },
      diffSummary: `Unusual follower change on ${input.followerAnomaly.platform} (z-score ${input.followerAnomaly.zScore.toFixed(1)})`,
      detectedAt: now,
      rawRefs: {},
    });
  }

  for (const burst of input.campaignBursts) {
    events.push({
      competitorId,
      pillar: 'social' as Pillar,
      field: `campaign:${burst.hashtag}`,
      oldValue: null,
      newValue: { hashtag: burst.hashtag, postCount: burst.postCount },
      diffSummary: `Likely campaign detected on ${burst.platform}: ${burst.postCount} posts using #${burst.hashtag}`,
      detectedAt: now,
      rawRefs: {},
    });
  }

  return events;
}

// ---------- Orchestration ----------

export interface SocialMonitoringConfig {
  competitorId: string;
  platform: 'instagram' | 'facebook' | 'x' | 'linkedin';
  handle: string;
}

export async function runSocialMonitoringCycle(
  provider: SocialDataProvider,
  config: SocialMonitoringConfig,
  followerHistory: number[]
) {
  const currentFollowers = await provider.getFollowerCount(config.handle);
  const anomaly = detectAnomaly(followerHistory, currentFollowers);

  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const posts = await provider.getRecentPosts(config.handle, oneWeekAgo);
  const topPosts = topPostsByEngagement(posts, currentFollowers);
  const bursts = detectCampaignBursts(posts);

  const changeEvents = buildSocialChangeEvents(config.competitorId, {
    followerAnomaly: { ...anomaly, platform: config.platform, newValue: currentFollowers },
    campaignBursts: bursts.map((b) => ({ hashtag: b.hashtag, postCount: b.postCount, platform: config.platform })),
  });

  return { currentFollowers, topPosts, bursts, changeEvents };
}
