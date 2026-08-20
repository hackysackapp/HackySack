import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing Authorization bearer token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // 1. Validate Token in Subscriptions Table
    const token = authHeader.replace("Bearer ", "").trim();
    if (!token) {
      return new Response(
        JSON.stringify({ error: "Missing token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 1. Match token directly in 'subscriptions' table
    let { data: dbSub, error: subError } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("jwt_token", token)
      .eq("status", "active")
      .maybeSingle();

    if (!dbSub) {
      const { data: stripeSub } = await supabase
        .from("subscriptions")
        .select("*")
        .eq("stripe_subscription_id", token)
        .eq("status", "active")
        .maybeSingle();
      if (stripeSub) dbSub = stripeSub;
    }

    if (!dbSub) {
      return new Response(
        JSON.stringify({ error: "Invalid, expired, or inactive HackySack Cloud token. Please check your subscription." }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const sub = dbSub;

    const contentType = req.headers.get("Content-Type") || "";

    // 2. Audio Transcription Proxy (Multipart Form Data)
    if (contentType.includes("multipart/form-data")) {
      const groqKey = Deno.env.get("GROQ_API_KEY") || Deno.env.get("OPENROUTER_API_KEY");
      const formData = await req.formData();
      if (!formData.has("model")) {
        formData.append("model", "whisper-large-v3-turbo");
      }

      let audioRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${groqKey}`,
        },
        body: formData,
      });

      if (!audioRes.ok) {
        console.warn(`Groq transcription failed (${audioRes.status}). Trying fallback OpenAI API...`);
        const openaiKey = Deno.env.get("OPENAI_API_KEY") || groqKey;
        audioRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${openaiKey}`,
          },
          body: formData,
        });
      }

      const audioData = await audioRes.text();
      return new Response(audioData, {
        status: audioRes.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. JSON Chat Completion Proxy
    const reqBody = await req.json();
    const { prompt, model, stream, action } = reqBody;

    // Reset daily counts if new calendar day (format date string safely)
    const today = new Date().toISOString().split("T")[0];
    const lastDate = sub.last_request_date ? String(sub.last_request_date).split("T")[0] : "";

    let standardCount = sub.daily_request_count || 0;
    let premiumCount = sub.daily_premium_count || 0;

    if (lastDate !== today) {
      standardCount = 0;
      premiumCount = 0;
    }

    // Status Ping check (used by desktop app to fetch usage stats)
    if (action === "status" || prompt === "__status__") {
      return new Response(
        JSON.stringify({
          status: sub.status || "active",
          daily_request_count: standardCount,
          daily_premium_count: premiumCount,
          daily_used: standardCount,
          daily_premium_used: premiumCount,
          standard_limit: 300,
          premium_limit: 150,
          remaining_standard: Math.max(0, 300 - standardCount),
          remaining_premium: Math.max(0, 150 - premiumCount)
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Model Resolution
    let targetModel = model || "google/gemini-2.5-flash";
    if (targetModel.includes("claude-3.7-sonnet") || targetModel.includes("claude-3.5-sonnet") || targetModel.includes("claude-sonnet")) {
      targetModel = "~anthropic/claude-sonnet-latest";
    } else if (targetModel.includes("claude-3-opus") || targetModel.includes("claude-opus")) {
      targetModel = "~anthropic/claude-opus-latest";
    } else if (targetModel.includes("claude-3-haiku") || targetModel.includes("claude-3.5-haiku") || targetModel.includes("claude-haiku")) {
      targetModel = "~anthropic/claude-haiku-latest";
    }

    // Model Credit Schedule
    const isPremiumModel = targetModel.includes("opus") || targetModel.includes("o1") || targetModel.includes("gpt-4.5") || targetModel.includes("sonnet") || (targetModel.includes("gpt-4o") && !targetModel.includes("mini")) || targetModel.includes("grok") || targetModel.includes("pro") || targetModel.includes("r1") || targetModel.includes("o3-mini");
    
    let queryCost = 1;
    if (targetModel.includes("opus") || targetModel.includes("o1") || targetModel.includes("gpt-4.5")) {
      queryCost = 3;
    } else if (targetModel.includes("sonnet") || (targetModel.includes("gpt-4o") && !targetModel.includes("mini"))) {
      queryCost = 2;
    } else {
      queryCost = 1;
    }

    if (isPremiumModel) {
      if (premiumCount + queryCost > 150) {
        return new Response(
          JSON.stringify({ error: `Daily Premium credit allowance reached (${premiumCount}/150 credits used today). Resets at midnight UTC.` }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    } else {
      if (standardCount + 1 > 300) {
        return new Response(
          JSON.stringify({ error: `Daily Standard response limit reached (${standardCount}/300 responses used today). Resets at midnight UTC.` }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    const openrouterKey = Deno.env.get("OPENROUTER_API_KEY");
    const isStreaming = Boolean(stream);

    const systemPrompt = "You are HackySack Teleprompter — a real-time live job interview assistant.\n\
FORMAT YOUR RESPONSE FOR 0.5-SECOND EYE GLANCING DURING A LIVE VIDEO CALL:\n\
\n\
- Do NOT use excessive emojis. Keep headers clean, professional, and easy to read.\n\
- Follow the requested response structure and length parameters provided in the prompt strictly.\n\
- SPEED & BREVITY RULE: Keep code/SQL snippets concise, clean, and directly executable without excessive commentary or boilerplate. Keep explanations punchy and under 150 words total for instant generation.\n\
- DYNAMIC SMART CODE RULE: If the question involves writing code, SQL queries, functions, algorithms, scripts, or implementations in ANY language/dialect (SQL, Python, TypeScript, Java, C++, Go, Rust, Bash, etc.), you MUST include a clean, copy-pasteable markdown code block with a working example snippet. If the question is non-technical, personal, or behavioral (e.g., 'Tell me about yourself'), NEVER output any code blocks.\n\
- CRITICAL RULE: NO conversational preamble ('Certainly', 'Great question', 'Here is'). Start IMMEDIATELY with the first section header.\n\
- Write in first person ('I', 'my') as an expert candidate.";

    // Check for images in context_items for multimodal vision
    const images: string[] = [];
    if (Array.isArray(context_items)) {
      for (const it of context_items) {
        if (typeof it?.content === "string" && it.content.startsWith("data:image/")) {
          images.push(it.content);
        }
      }
    }

    let userContent: any = prompt;
    if (images.length > 0) {
      userContent = [
        { type: "text", text: prompt },
        ...images.map(url => ({ type: "image_url", image_url: { url } }))
      ];
    }

    // Call OpenRouter with primary model
    let aiRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openrouterKey}`,
        "HTTP-Referer": "https://hackysackapp.github.io/HackySack",
        "X-Title": "HackySack Assistant",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: targetModel,
        stream: isStreaming,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent }
        ],
        temperature: 0.7,
        max_tokens: 1500,
      }),
    });

    // Fallback to high-reliability Gemini 2.5 Flash if requested model is temporarily offline on OpenRouter
    if (!aiRes.ok && targetModel !== "google/gemini-2.5-flash") {
      console.warn(`Primary model ${targetModel} failed (${aiRes.status}). Falling back to google/gemini-2.5-flash...`);
      targetModel = "google/gemini-2.5-flash";
      aiRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${openrouterKey}`,
          "HTTP-Referer": "https://hackysackapp.github.io/HackySack",
          "X-Title": "HackySack Assistant",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: targetModel,
          stream: isStreaming,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent }
          ],
          temperature: 0.7,
          max_tokens: 1500,
        }),
      });
    }

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      return new Response(
        JSON.stringify({ error: `AI provider error: ${errText}` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Update usage count in DB
    const newStandardCount = standardCount + 1;
    const newPremiumCount = isPremiumModel ? premiumCount + queryCost : premiumCount;

    try {
      if (sub.id) {
        await supabase
          .from("subscriptions")
          .update({
            daily_request_count: newStandardCount,
            daily_premium_count: newPremiumCount,
            last_request_date: today
          })
          .eq("id", sub.id);
      }
    } catch (dbErr) {
      console.warn("[PROXY] DB usage update notice:", dbErr);
    }

    // If client requested SSE stream, pipe OpenRouter stream directly to client
    if (isStreaming && aiRes.body) {
      return new Response(aiRes.body, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    const aiData = await aiRes.json();
    aiData.daily_used = newStandardCount;
    aiData.daily_premium_used = newPremiumCount;
    aiData.daily_limit = isPremiumModel ? 150 : 300;

    return new Response(
      JSON.stringify(aiData),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
