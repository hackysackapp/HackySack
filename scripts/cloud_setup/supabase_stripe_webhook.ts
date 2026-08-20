import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  try {
    const body = await req.json();
    console.log("Received webhook event:", body.type);

    const session = body.data?.object || {};
    const customerEmail = session.customer_details?.email || session.customer_email || session.email || "subscriber@hackysack.app";
    const checkoutSessionId = session.id || "";
    const stripeSubscriptionId = session.subscription || session.id || `sub_${Date.now()}`;

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const uniqueToken = checkoutSessionId ? checkoutSessionId : `hs_cloud_${crypto.randomUUID().replace(/-/g, "")}`;

    // Upsert subscription record matching by either checkoutSessionId or stripeSubscriptionId
    const { data, error } = await supabase.from("subscriptions").upsert({
      user_email: customerEmail,
      stripe_subscription_id: stripeSubscriptionId,
      jwt_token: checkoutSessionId || uniqueToken,
      status: "active",
      daily_request_count: 0,
      daily_premium_count: 0,
      last_request_date: new Date().toISOString().split("T")[0]
    }, { onConflict: "stripe_subscription_id" }).select();

    if (error) {
      console.error("Database error inserting subscription:", error);
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }

    console.log(`Successfully activated cloud token ${uniqueToken} for ${customerEmail}`);
    return new Response(JSON.stringify({ received: true, token: uniqueToken }), { status: 200 });
  } catch (err: any) {
    console.error("Webhook processing error:", err);
    return new Response(JSON.stringify({ error: err.message }), { status: 400 });
  }
});
