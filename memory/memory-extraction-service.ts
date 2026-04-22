/**
 * Memory Extraction Service
 * STEP 7: Extract and store memories after conversations
 * 
 * This service runs asynchronously after each conversation to:
 * 1. Extract important facts, preferences, and context
 * 2. Generate embeddings for each memory
 * 3. Store in Firestore with metadata
 */

import { getMemorySystemService } from './memory-system-service';
import type { MemoryCategory } from './memory-system-service';

export interface ConversationContext {
  userMessage: string;
  assistantResponse: string;
  userId: string;
}

/**
 * Memory Extraction Service for SOHAM
 */
export class MemoryExtractionService {
  private memorySystem = getMemorySystemService();

  /**
   * Extract and store memories from a conversation
   * This runs asynchronously and doesn't block the response
   */
  async extractAndStore(context: ConversationContext): Promise<number> {
    try {
      console.log('[Memory Extraction] Processing conversation for user:', context.userId);

      // Combine user message and assistant response
      const conversationText = `User: ${context.userMessage}\nAssistant: ${context.assistantResponse}`;

      // Use Cerebras to extract important memories
      const memories = await this.extractMemoriesWithCerebras(conversationText);

      if (memories.length === 0) {
        console.log('[Memory Extraction] No important memories found');
        return 0;
      }

      console.log(`[Memory Extraction] Extracted ${memories.length} memories`);

      // Store each memory with metadata
      let storedCount = 0;
      for (const memoryContent of memories) {
        try {
          // Classify memory type
          const category = this.classifyMemory(memoryContent);
          
          // Calculate importance
          const importance = this.calculateImportance(memoryContent);
          
          // Extract tags
          const tags = this.extractTags(memoryContent);

          // Store in Firestore (this also generates embeddings)
          await this.memorySystem.storeMemory(context.userId, memoryContent, {
            category,
            importance,
            tags,
          });

          storedCount++;
          console.log(`[Memory Extraction] Stored: ${memoryContent.substring(0, 60)}...`);
        } catch (error) {
          console.error('[Memory Extraction] Failed to store memory:', error);
        }
      }

      console.log(`[Memory Extraction] Successfully stored ${storedCount}/${memories.length} memories`);
      return storedCount;
    } catch (error) {
      console.error('[Memory Extraction] Failed:', error);
      return 0;
    }
  }

  /**
   * Extract memories using an LLM (Cerebras → Groq fallback).
   * Falls back to rule-based extractor if no API key is available.
   */
  private async extractMemoriesWithCerebras(conversationText: string): Promise<string[]> {
    const cerebrasKey = process.env.CEREBRAS_API_KEY;
    const groqKey = process.env.GROQ_API_KEY;
    const apiKey = cerebrasKey || groqKey;
    const baseUrl = cerebrasKey
      ? 'https://api.cerebras.ai/v1'
      : 'https://api.groq.com/openai/v1';
    const model = 'llama-3.3-70b-versatile';

    // ── LLM extraction path ────────────────────────────────────────────────
    if (apiKey) {
      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: 'system',
                content: `You are a memory extraction system. Extract important, long-term facts from conversations.

Return ONLY a JSON array of memory strings. Each memory must be:
- A complete, standalone statement (no pronouns like "I" or "they")
- Specific and concrete (not vague)
- Worth remembering across future conversations
- Written in third person: "User prefers..." / "User is..." / "User works on..."

Categories to extract:
- PERSONAL: name, age, location, contact info
- PREFERENCE: likes, dislikes, preferred tools/styles/approaches
- SKILL: expertise, proficiency, technologies known
- CONTEXT: current projects, goals, work situation
- FACT: any other important factual information

Only extract genuinely important information. Skip small talk, greetings, and transient details.

Examples:
["User's name is Harsh", "User prefers TypeScript over JavaScript", "User is building a React app with Next.js", "User is an expert in Python and machine learning"]

If nothing important to remember, return: []`,
              },
              { role: 'user', content: conversationText },
            ],
            temperature: 0.2,
            max_tokens: 600,
          }),
          signal: AbortSignal.timeout(12000),
        });

        if (!response.ok) throw new Error(`API error: ${response.statusText}`);

        const data = await response.json() as any;
        const raw = (data.choices[0].message.content as string).trim();

        // Extract JSON array even if wrapped in markdown code blocks
        const jsonMatch = raw.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return [];

        try {
          const memories = JSON.parse(jsonMatch[0]);
          return Array.isArray(memories)
            ? memories.filter((m: any) => typeof m === 'string' && m.length > 10 && m.length < 300)
            : [];
        } catch {
          console.warn('[Memory Extraction] Failed to parse LLM response as JSON');
          return [];
        }
      } catch (error) {
        console.warn('[Memory Extraction] LLM extraction failed, using rule-based fallback:', error instanceof Error ? error.message : error);
      }
    }

    // ── Rule-based fallback (no API key needed) ────────────────────────────
    return this.extractMemoriesRuleBased(conversationText);
  }

  /**
   * Lightweight rule-based memory extractor — no API key required.
   * Catches the most common patterns: names, preferences, skills, projects.
   */
  private extractMemoriesRuleBased(text: string): string[] {
    const memories: string[] = [];
    const lines = text.split('\n').filter(l => l.trim());

    for (const line of lines) {
      const lower = line.toLowerCase();

      // Name patterns
      const nameMatch = line.match(/(?:my name is|i(?:'m| am) called|call me)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
      if (nameMatch) memories.push(`User's name is ${nameMatch[1]}`);

      // Preference patterns
      if (/\bi (?:prefer|like|love|enjoy|hate|dislike|don't like)\b/i.test(line)) {
        const clean = line.replace(/^(user:|assistant:)\s*/i, '').trim();
        if (clean.length < 200) memories.push(`User preference: ${clean}`);
      }

      // Skill / expertise patterns
      if (/\bi(?:'m| am) (?:a |an )?(?:expert|senior|junior|developer|engineer|designer|student|teacher|doctor|lawyer)\b/i.test(line)) {
        const clean = line.replace(/^(user:|assistant:)\s*/i, '').trim();
        if (clean.length < 200) memories.push(`User background: ${clean}`);
      }

      // Working on / project patterns
      if (/\bi(?:'m| am) (?:working on|building|developing|creating)\b/i.test(line)) {
        const clean = line.replace(/^(user:|assistant:)\s*/i, '').trim();
        if (clean.length < 200) memories.push(`User context: ${clean}`);
      }

      // Language / tech preferences
      const techMatch = line.match(/\bi (?:use|work with|code in|program in)\s+([A-Za-z+#]+(?:,\s*[A-Za-z+#]+)*)/i);
      if (techMatch) memories.push(`User uses: ${techMatch[1]}`);
    }

    // Deduplicate
    return [...new Set(memories)].slice(0, 5);
  }

  /**
   * Classify memory into categories with improved heuristics
   */
  private classifyMemory(content: string): MemoryCategory {
    const lower = content.toLowerCase();

    // Personal facts (name, age, location, contact)
    if (/\b(name is|called|age|years old|live in|from|email|phone|contact)\b/i.test(lower)) {
      return 'FACT';
    }

    // Preferences (likes, dislikes, wants, prefers)
    if (/\b(prefer|like|love|enjoy|hate|dislike|want|need|favorite|favourite)\b/i.test(lower)) {
      return 'PREFERENCE';
    }

    // Skills (expert, proficient, knows, can code, experienced)
    if (/\b(expert|skilled|proficient|knows|experienced|can code|familiar with|good at|specialize)\b/i.test(lower)) {
      return 'SKILL';
    }

    // Context (working on, project, currently, building, developing)
    if (/\b(working on|project|currently|building|developing|creating|studying|learning)\b/i.test(lower)) {
      return 'CONTEXT';
    }

    // Conversation snippets (discussed, talked about, mentioned)
    if (/\b(discussed|talked about|mentioned|asked about|explained|said)\b/i.test(lower)) {
      return 'CONVERSATION';
    }

    // Default to fact
    return 'FACT';
  }

  /**
   * Calculate importance score (0-1 range) with improved weighting
   */
  private calculateImportance(content: string): number {
    let score = 0.4; // Base score (lowered from 0.5)
    const lower = content.toLowerCase();

    // Critical: Personal identifiers (name, contact, location)
    if (/\b(name is|email|phone|address|live in|from)\b/i.test(lower)) {
      score += 0.4;
    }

    // High: Skills and expertise
    if (/\b(expert|proficient|skilled|experienced|specialize)\b/i.test(lower)) {
      score += 0.3;
    }

    // High: Strong preferences
    if (/\b(always|never|must|require|essential|critical)\b/i.test(lower)) {
      score += 0.25;
    }

    // Medium-high: Preferences and current context
    if (/\b(prefer|working on|project|building)\b/i.test(lower)) {
      score += 0.2;
    }

    // Medium: Likes/dislikes
    if (/\b(like|enjoy|love|hate|dislike)\b/i.test(lower)) {
      score += 0.15;
    }

    // Low: General conversation
    if (/\b(discussed|mentioned|talked)\b/i.test(lower)) {
      score += 0.05;
    }

    // Penalty for vague/generic statements
    if (content.length < 20 || /\b(maybe|perhaps|might|could be|not sure)\b/i.test(lower)) {
      score -= 0.15;
    }

    return Math.min(1.0, Math.max(0.1, score));
  }

  /**
   * Extract relevant tags with expanded tech keywords and domain categories
   */
  private extractTags(content: string): string[] {
    const tags: string[] = [];
    const lower = content.toLowerCase();

    // Programming languages
    const languages = [
      'python', 'javascript', 'typescript', 'java', 'c++', 'c#', 'go', 'rust',
      'swift', 'kotlin', 'php', 'ruby', 'scala', 'r', 'matlab', 'dart', 'lua',
      'perl', 'haskell', 'elixir', 'clojure', 'f#', 'ocaml', 'erlang', 'julia'
    ];
    languages.forEach(lang => {
      if (new RegExp(`\\b${lang}\\b`, 'i').test(lower)) tags.push(lang);
    });

    // Frameworks & libraries
    const frameworks = [
      'react', 'vue', 'angular', 'svelte', 'nextjs', 'nuxt', 'gatsby', 'remix',
      'django', 'flask', 'fastapi', 'express', 'nestjs', 'spring', 'laravel',
      'rails', 'asp.net', 'tensorflow', 'pytorch', 'keras', 'scikit-learn',
      'pandas', 'numpy', 'matplotlib', 'opencv', 'unity', 'unreal', 'godot'
    ];
    frameworks.forEach(fw => {
      if (new RegExp(`\\b${fw}\\b`, 'i').test(lower)) tags.push(fw);
    });

    // Databases
    const databases = [
      'mongodb', 'postgresql', 'mysql', 'redis', 'sqlite', 'cassandra',
      'dynamodb', 'firestore', 'supabase', 'prisma', 'sequelize', 'typeorm'
    ];
    databases.forEach(db => {
      if (new RegExp(`\\b${db}\\b`, 'i').test(lower)) tags.push(db);
    });

    // DevOps & Cloud
    const devops = [
      'docker', 'kubernetes', 'aws', 'azure', 'gcp', 'vercel', 'netlify',
      'heroku', 'digitalocean', 'terraform', 'ansible', 'jenkins', 'github actions',
      'gitlab ci', 'circleci', 'travis'
    ];
    devops.forEach(tool => {
      if (new RegExp(`\\b${tool.replace(/\s+/g, '\\s+')}\\b`, 'i').test(lower)) {
        tags.push(tool.replace(/\s+/g, '-'));
      }
    });

    // Domain categories
    if (/\b(web|frontend|backend|fullstack|ui|ux)\b/i.test(lower)) tags.push('web-dev');
    if (/\b(mobile|ios|android|react native|flutter)\b/i.test(lower)) tags.push('mobile');
    if (/\b(ml|ai|machine learning|deep learning|neural|model)\b/i.test(lower)) tags.push('ai-ml');
    if (/\b(data|analytics|visualization|dashboard|bi)\b/i.test(lower)) tags.push('data');
    if (/\b(game|gaming|3d|graphics|shader)\b/i.test(lower)) tags.push('gamedev');
    if (/\b(security|auth|encryption|vulnerability|penetration)\b/i.test(lower)) tags.push('security');
    if (/\b(api|rest|graphql|grpc|microservice)\b/i.test(lower)) tags.push('api');
    if (/\b(test|testing|unit test|integration|e2e|jest|pytest)\b/i.test(lower)) tags.push('testing');

    // Semantic categories
    if (/\b(prefer|preference|like|favorite)\b/i.test(lower)) tags.push('preference');
    if (/\b(project|working on|building)\b/i.test(lower)) tags.push('project');
    if (/\b(work|job|career|company)\b/i.test(lower)) tags.push('work');
    if (/\b(learn|study|course|tutorial|education)\b/i.test(lower)) tags.push('learning');
    if (/\b(skill|expert|proficient|experienced)\b/i.test(lower)) tags.push('skill');
    if (/\b(name|personal|contact|location)\b/i.test(lower)) tags.push('personal');
    if (/\b(code|coding|programming|develop)\b/i.test(lower)) tags.push('coding');

    return tags.length > 0 ? [...new Set(tags)] : ['general'];
  }

  /**
   * Memory extraction is always enabled — Cerebras is used when available,
   * rule-based fallback is used otherwise.
   */
  isEnabled(): boolean {
    return true;
  }
}

// Export singleton
let memoryExtractionService: MemoryExtractionService | null = null;

export function getMemoryExtractionService(): MemoryExtractionService {
  if (!memoryExtractionService) {
    memoryExtractionService = new MemoryExtractionService();
  }
  return memoryExtractionService;
}
