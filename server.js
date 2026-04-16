import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import Stripe from 'stripe';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.use(cors());
app.use(express.json({ limit: '150kb' }));
app.use(express.static(join(__dirname, 'public')));

// Stable system prompt — cached via cache_control
const SYSTEM_PROMPT = `You are ContractGuard AI, an expert contract analyst specializing in protecting freelancers, consultants, and small businesses from unfair contract terms.

Your job is to analyze contracts and return a JSON object — nothing else, no markdown, no preamble, no explanation. Pure JSON only.

Return this exact structure:
{
  "riskScore": <integer 0-100, where 0=very safe, 100=critical risk>,
  "riskLevel": <"Low" | "Medium" | "High" | "Critical">,
  "summary": "<2-3 sentence plain English summary of what this contract is and what to watch out for>",
  "overallAssessment": "<2-3 actionable sentences: should they sign as-is, negotiate, or walk away? Be specific.>",
  "redFlags": [
    {
      "severity": <"low" | "medium" | "high" | "critical">,
      "clause": "<short name or description of the problematic term>",
      "explanation": "<plain English: why this is bad for the signer>",
      "recommendation": "<specific, actionable thing to do about this>"
    }
  ],
  "keyClauses": [
    {
      "type": "<clause category e.g. Payment Terms, IP Ownership, Non-Compete, Liability Cap, Termination>",
      "summary": "<plain English: what this clause actually says>",
      "favorable": <true if beneficial to the signer, false if not>
    }
  ],
  "missingProtections": ["<important clause that should be present but isn't>"],
  "negotiationPoints": ["<specific thing to push back on and why — be direct and tactical>"]
}

Risk scoring guide:
- 0-25 (Low): Generally safe to sign. Minor issues that are common and acceptable.
- 26-50 (Medium): Some concerns. Negotiate specific points before signing.
- 51-75 (High): Significant risks. Major negotiation or redrafting required.
- 76-100 (Critical): Dangerous. Do not sign without major revisions or legal counsel.

Focus on practical business risks: IP ownership traps, non-compete overreach, uncapped liability, payment clauses with escape hatches, auto-renewal traps, unilateral change rights, IP indemnification exposure, forced arbitration in bad venues.

Always respond with ONLY valid JSON. No markdown fences, no leading text, no trailing text.`;

// ── Verify active Stripe subscription ──────────────────────────────────────
async function hasActiveSubscription(customerId) {
  try {
    const subs = await stripe.subscriptions.list({
      customer: customerId,
      status: 'active',
      limit: 1
    });
    return subs.data.length > 0;
  } catch {
    return false;
  }
}

// ── POST /api/checkout ──────────────────────────────────────────────────────
app.post('/api/checkout', async (req, res) => {
  const { plan } = req.body;

  const priceId = plan === 'business'
    ? process.env.STRIPE_BUSINESS_PRICE_ID
    : process.env.STRIPE_PRO_PRICE_ID;

  if (!priceId) {
    return res.status(500).json({ error: `Price ID for plan "${plan}" is not configured. Set STRIPE_PRO_PRICE_ID / STRIPE_BUSINESS_PRICE_ID in .env` });
  }

  const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `http://localhost:3000?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `http://localhost:3000`,
      allow_promotion_codes: true,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session.' });
  }
});

// ── GET /api/verify-subscription?session_id=xxx ─────────────────────────────
app.get('/api/verify-subscription', async (req, res) => {
  const { session_id } = req.query;

  if (!session_id) {
    return res.status(400).json({ error: 'session_id is required.' });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['subscription', 'customer']
    });

    if (session.payment_status !== 'paid' && session.status !== 'complete') {
      return res.status(402).json({ error: 'Payment not completed.' });
    }

    const customer = session.customer;
    const customerId = typeof customer === 'string' ? customer : customer.id;
    const email = typeof customer === 'string' ? null : customer.email;

    // Determine plan from subscription
    let plan = 'pro';
    if (session.subscription) {
      const sub = typeof session.subscription === 'string'
        ? await stripe.subscriptions.retrieve(session.subscription)
        : session.subscription;
      const priceId = sub.items.data[0]?.price?.id;
      if (priceId === process.env.STRIPE_BUSINESS_PRICE_ID) plan = 'business';
    }

    res.json({ success: true, customerId, email, plan });
  } catch (err) {
    console.error('Verify error:', err.message);
    res.status(500).json({ error: 'Failed to verify subscription.' });
  }
});

// ── GET /api/check-subscription?customer_id=xxx ─────────────────────────────
app.get('/api/check-subscription', async (req, res) => {
  const { customer_id } = req.query;

  if (!customer_id) {
    return res.status(400).json({ error: 'customer_id is required.' });
  }

  const active = await hasActiveSubscription(customer_id);
  res.json({ active });
});

// ── POST /api/analyze ────────────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { contractText } = req.body;
  const customerId = req.headers['x-customer-id'];

  // If a customer ID is provided, verify the subscription is active
  if (customerId) {
    const active = await hasActiveSubscription(customerId);
    if (!active) {
      return res.status(402).json({ error: 'Your subscription is inactive. Please renew to continue.', code: 'subscription_inactive' });
    }
  }

  if (!contractText || typeof contractText !== 'string') {
    return res.status(400).json({ error: 'Contract text is required.' });
  }

  const trimmed = contractText.trim();

  if (trimmed.length < 80) {
    return res.status(400).json({ error: 'Contract text is too short. Please paste more of the contract.' });
  }

  if (trimmed.length > 60000) {
    return res.status(400).json({ error: 'Contract is too long (max ~60,000 characters). Paste the most relevant sections.' });
  }

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2048,
      // Cache the stable system prompt — saves ~70% on repeated requests
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Analyze this contract and return JSON only:\n\n${trimmed}`
            }
          ]
        }
      ]
    });

    const block = response.content[0];
    if (!block || block.type !== 'text') {
      throw new Error('Unexpected response format');
    }

    // Strip any accidental markdown code fences
    let jsonText = block.text.trim();
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    }

    const analysis = JSON.parse(jsonText);

    // Log cache usage (helps verify caching is working)
    const { cache_creation_input_tokens, cache_read_input_tokens, input_tokens } = response.usage;
    console.log(`[analysis] cached_read=${cache_read_input_tokens} cached_created=${cache_creation_input_tokens} uncached=${input_tokens}`);

    res.json({ success: true, analysis });

  } catch (err) {
    console.error('Analysis error:', err.message);

    if (err instanceof Anthropic.AuthenticationError) {
      return res.status(500).json({ error: 'API key is invalid. Check your ANTHROPIC_API_KEY.' });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'Rate limit reached. Please wait a moment and try again.' });
    }
    if (err instanceof SyntaxError) {
      return res.status(500).json({ error: 'Failed to parse analysis response. Please try again.' });
    }

    res.status(500).json({ error: 'Analysis failed. Please try again.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════╗`);
  console.log(`  ║      ContractGuard AI  🛡         ║`);
  console.log(`  ╚══════════════════════════════════╝`);
  console.log(`\n  Running at: http://localhost:${PORT}`);
  console.log(`  Press Ctrl+C to stop\n`);
});
