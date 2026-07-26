import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase'; // Using the service role or anon client

async function geminiGenerate(prompt: string): Promise<string | null> {
  const key = process.env.GEMINI_API_KEY || process.env.NEXT_PUBLIC_GEMINI_API_KEY;
  if (!key) {
    console.info('[AI Service] chat Gemini skipped, GEMINI_API_KEY not configured');
    return null;
  }
  console.info('[AI Service] chat geminiGenerate', {
    model: 'gemini-1.5-flash',
    promptLength: prompt.length,
  });
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 800 },
        }),
      },
    );
    if (!res.ok) {
      console.error('[AI Service] chat geminiGenerate response error', { status: res.status, statusText: res.statusText });
      return null;
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  } catch (err) {
    console.error('[AI Service] chat geminiGenerate failed', err);
    return null;
  }
}

export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Authorization header is required" }, { status: 401 });
    }
    const token = authHeader.slice("Bearer ".length);
    
    // Get user from token
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = authData.user.id;

    const body = await request.json();
    const question: string = body.question;
    const competitorId: string | undefined = body.competitorId;

    if (!question || typeof question !== "string" || !question.trim()) {
      return NextResponse.json({ error: "question is required" }, { status: 400 });
    }

    // 1. Get workspace ID
    const { data: wm } = await supabase
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", userId)
      .limit(1)
      .single();

    const workspaceId = wm?.workspace_id;

    // 2. Fetch competitors to provide as context
    let competitorsData: any[] = [];
    if (workspaceId) {
      let query = supabase.from("competitors").select("name, website, industry, description").eq("workspace_id", workspaceId);
      if (competitorId) {
         query = query.eq("id", competitorId);
      }
      const { data } = await query;
      if (data) {
        competitorsData = data;
      }
    }

    const prompt = `You are a helpful competitor intelligence and marketing AI assistant.
Answer the user's question using the provided competitor data from their database and your general knowledge about marketing news, strategies, and trends.

User's Competitor Data:
${JSON.stringify(competitorsData, null, 2)}

Instructions:
- If the question is about their competitors, use the provided data.
- If the question is about general marketing news, strategies, or trends, use your vast knowledge to provide a highly informative answer.
- Keep the response clear, structured, and helpful.

Question:
${question}`;

    let answer = await geminiGenerate(prompt);
    if (!answer) {
      answer = "I'm sorry, I couldn't generate a response at this time.";
    }

    // Persist user question and assistant answer in chat_messages
    await supabase.from("chat_messages").insert([
      {
        workspace_id: workspaceId || userId,
        competitor_id: competitorId ?? null,
        role: "user",
        content: question,
        sources: [],
      },
      {
        workspace_id: workspaceId || userId,
        competitor_id: competitorId ?? null,
        role: "assistant",
        content: answer,
        sources: [],
      },
    ]);

    return NextResponse.json({ answer, sources: [] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Chat failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
