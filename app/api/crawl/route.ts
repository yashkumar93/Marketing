import { NextResponse } from "next/server";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get("Authorization");
    const { url, page_id } = await req.json();

    if (!url || !page_id) {
      return NextResponse.json({ error: "Missing url or page_id" }, { status: 400 });
    }

    // Launch Playwright chromium browser
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();

    // Navigate and wait for network idle
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    
    // Give single-page apps a tiny bit extra time to render DOM
    await new Promise(resolve => setTimeout(resolve, 2000));

    const html = await page.content();
    const screenshotBuffer = await page.screenshot({ fullPage: true });

    await browser.close();

    // Upload to Supabase Storage
    const timestamp = new Date().getTime();
    const fileName = `${page_id}_${timestamp}.png`;
    
    // Create an authenticated client if we received an auth header
    const supabaseOptions = authHeader ? {
      global: { headers: { Authorization: authHeader } }
    } : {};
    
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      supabaseOptions
    );

    const { data: uploadData, error: uploadError } = await supabase
      .storage
      .from("screenshots")
      .upload(fileName, screenshotBuffer, {
        contentType: "image/png",
        upsert: true
      });

    if (uploadError) {
      console.error("Failed to upload screenshot:", uploadError);
    }

    const { data: publicUrlData } = supabase
      .storage
      .from("screenshots")
      .getPublicUrl(fileName);

    return NextResponse.json({ 
      html, 
      screenshot_url: publicUrlData.publicUrl 
    });

  } catch (error: any) {
    console.error("Crawl Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
