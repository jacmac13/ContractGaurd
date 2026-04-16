import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

app.post('/api/analyze', async (req, res) => {
  const { contractText } = req.body;

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
