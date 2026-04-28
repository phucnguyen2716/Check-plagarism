export function calculateSimilarity(text1, text2) {
  const words1 = text1.toLowerCase().split(/\s+/);
  const words2 = text2.toLowerCase().split(/\s+/);

  const allWords = [...new Set([...words1, ...words2])];

  const vector1 = allWords.map((word) => words1.filter((w) => w === word).length);
  const vector2 = allWords.map((word) => words2.filter((w) => w === word).length);

  const dotProduct = vector1.reduce((sum, val, i) => sum + val * vector2[i], 0);
  const magnitude1 = Math.sqrt(vector1.reduce((sum, val) => sum + val * val, 0));
  const magnitude2 = Math.sqrt(vector2.reduce((sum, val) => sum + val * val, 0));

  if (magnitude1 === 0 || magnitude2 === 0) return 0;

  return dotProduct / (magnitude1 * magnitude2);
}

export async function searchWeb(query) {
  const urls = [];

  try {
    const searchQuery = encodeURIComponent(query.slice(0, 240));
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${searchQuery}`;

    const response = await fetch(ddgUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://duckduckgo.com/",
      },
    });

    const html = await response.text();

    // More robust regex for DDG links
    const resultMatches = html.match(/uddg=([^"&']+)["&']/g) || [];
    const ddgUrls = resultMatches
      .map((match) => {
        let encoded = match.replace("uddg=", "").replace(/["&']$/, "");
        try {
          return decodeURIComponent(encoded);
        } catch {
          return null;
        }
      })
      .filter(
        (url) => url && url.startsWith("http") && !url.includes("duckduckgo.com")
      )
      .slice(0, 10);

    urls.push(...ddgUrls.filter(url => url !== null));
  } catch (error) {
    console.error("DuckDuckGo search error:", error);
  }

  try {
    const searchQuery = encodeURIComponent(query.slice(0, 150));
    const crossrefUrl = `https://api.crossref.org/works?query=${searchQuery}&rows=5`;

    const response = await fetch(crossrefUrl);
    const data = await response.json();

    if (data.message?.items) {
      for (const item of data.message.items) {
        if (item.URL) {
          urls.push(item.URL);
        }
      }
    }
  } catch (error) {
    // console.error("CrossRef search error:", error);
  }

  return [...new Set(urls)].slice(0, 10);
}

const COMMON_USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0"
];

export async function fetchPageContent(url, retries = 1) {
  const userAgent = COMMON_USER_AGENTS[Math.floor(Math.random() * COMMON_USER_AGENTS.length)];
  
  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(url, {
        headers: {
          "User-Agent": userAgent,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "max-age=0",
          "Sec-Ch-Ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
          "Sec-Ch-Ua-Mobile": "?0",
          "Sec-Ch-Ua-Platform": '"Windows"',
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "cross-site",
          "Sec-Fetch-User": "?1",
          "Upgrade-Insecure-Requests": "1",
          "Referer": "https://www.google.com/"
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        if (response.status === 403) {
          // Some sites are just very hard to scrape without a real browser
          // console.log(`Access Forbidden (403) for ${url}`);
          return "";
        }
        console.log(`Failed to fetch ${url}: ${response.status}`);
        return "";
      }

      const html = await response.text();

      // Better HTML cleaning
      let text = html
        .replace(/<script[^>]*>.*?<\/script>/gis, " ")
        .replace(/<style[^>]*>.*?<\/style>/gis, " ")
        .replace(/<nav[^>]*>.*?<\/nav>/gis, " ")
        .replace(/<header[^>]*>.*?<\/header>/gis, " ")
        .replace(/<footer[^>]*>.*?<\/footer>/gis, " ")
        .replace(/<aside[^>]*>.*?<\/aside>/gis, " ")
        .replace(/<form[^>]*>.*?<\/form>/gis, " ")
        .replace(/<svg[^>]*>.*?<\/svg>/gis, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&[a-z0-9]+;/gi, " ")
        .replace(/\s+/g, " ")
        .trim();

      return text.slice(0, 8000);
    } catch (error) {
      const isTransient = error.code === 'EAI_FAIL' || error.code === 'ENOTFOUND' || error.name === 'AbortError' || error.code === 'ECONNRESET';
      
      if (isTransient && i < retries) {
        // console.log(`Retrying ${url} due to ${error.code || error.name}...`);
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        continue;
      }
      
      if (error.name !== 'AbortError') {
        console.error(`Error fetching ${url}:`, error.message || error);
      } else {
        console.log(`Timeout fetching ${url}`);
      }
      return "";
    }
  }
  return "";
}

export function nGramSimilarity(text1, text2, n = 5) {
  const createNGrams = (text) => {
    const words = text.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/);
    const ngrams = new Set();
    for (let i = 0; i <= words.length - n; i++) {
      ngrams.add(words.slice(i, i + n).join(" "));
    }
    return ngrams;
  };

  const ngrams1 = createNGrams(text1);
  const ngrams2 = createNGrams(text2);

  if (ngrams1.size === 0 || ngrams2.size === 0) return 0;

  let matches = 0;
  for (const gram of ngrams1) {
    if (ngrams2.has(gram)) matches++;
  }

  return matches / Math.max(ngrams1.size, ngrams2.size);
}
