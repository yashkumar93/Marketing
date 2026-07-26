import Groq from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const EXTRACTION_PROMPT = `Extract all pricing tiers from the following pricing page text.
Respond with ONLY a JSON array, no other text, matching this shape exactly:
[{"tierName": string, "price": number | null, "currency": string, "billingPeriod": "monthly" | "annual", "features": string[]}]

Use price: null for "Contact Sales" / custom pricing tiers.
If no pricing information is present, respond with [].

Page text:
"""
{{PAGE_TEXT}}
"""`;

export interface PricingTier {
  tierName: string;
  price: number | null;
  currency: string;
  billingPeriod: 'monthly' | 'annual';
  features: string[];
}

export interface LocalPricingSnapshot {
  tiers: PricingTier[];
}

export async function extractPricingWithLLM(pageText: string): Promise<PricingTier[]> {
  const response = await groq.chat.completions.create({
    model: 'llama3-8b-8192', // cheap + fast is fine for structured extraction
    max_tokens: 1024,
    messages: [{ role: 'user', content: EXTRACTION_PROMPT.replace('{{PAGE_TEXT}}', pageText.slice(0, 8000)) }],
  });

  const textResponse = response.choices[0]?.message?.content;
  if (!textResponse) throw new Error('No text response from extraction call');

  return validatePricingTiers(safeParseJson(textResponse));
}

function safeParseJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```json\n?/, '').replace(/```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error('Extraction returned malformed JSON — flag this snapshot for manual review');
  }
}

function validatePricingTiers(data: unknown): PricingTier[] {
  if (!Array.isArray(data)) throw new Error('Expected an array of pricing tiers');

  return data.map((tier: any) => {
    if (typeof tier.tierName !== 'string') throw new Error('Invalid tier: missing tierName');
    if (tier.price !== null && (typeof tier.price !== 'number' || tier.price < 0 || tier.price > 1_000_000)) {
      // Sanity bound catches obvious extraction errors (e.g. the model grabbing a phone number).
      throw new Error(`Invalid price for tier "${tier.tierName}"`);
    }
    return {
      tierName: tier.tierName,
      price: tier.price ?? null,
      currency: tier.currency ?? 'USD',
      billingPeriod: tier.billingPeriod === 'annual' ? 'annual' : 'monthly',
      features: Array.isArray(tier.features) ? tier.features : [],
    };
  });
}

export interface PricingChange {
  type: 'price_change' | 'tier_added' | 'tier_removed' | 'feature_changed';
  tierName: string;
  detail: string;
  percentChange?: number;
}

export function diffPricingSnapshots(previous: LocalPricingSnapshot, current: LocalPricingSnapshot): PricingChange[] {
  const changes: PricingChange[] = [];
  const prevByName = new Map(previous.tiers.map((t) => [t.tierName, t]));
  const currByName = new Map(current.tiers.map((t) => [t.tierName, t]));

  for (const [name, currTier] of currByName) {
    const prevTier = prevByName.get(name);

    if (!prevTier) {
      changes.push({ type: 'tier_added', tierName: name, detail: `New tier "${name}" added` });
      continue;
    }

    if (prevTier.price !== currTier.price) {
      const pctChange =
        prevTier.price && currTier.price ? ((currTier.price - prevTier.price) / prevTier.price) * 100 : undefined;
      changes.push({
        type: 'price_change',
        tierName: name,
        detail: `Price changed from ${prevTier.price ?? 'custom'} to ${currTier.price ?? 'custom'}`,
        percentChange: pctChange,
      });
    }

    const addedFeatures = currTier.features.filter((f) => !prevTier.features.includes(f));
    const removedFeatures = prevTier.features.filter((f) => !currTier.features.includes(f));
    if (addedFeatures.length || removedFeatures.length) {
      changes.push({
        type: 'feature_changed',
        tierName: name,
        detail: `+${addedFeatures.length} features, -${removedFeatures.length} features`,
      });
    }
  }

  for (const name of prevByName.keys()) {
    if (!currByName.has(name)) {
      changes.push({ type: 'tier_removed', tierName: name, detail: `Tier "${name}" removed` });
    }
  }

  return changes;
}
