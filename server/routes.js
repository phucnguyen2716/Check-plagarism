import { createServer } from "http";
import { checkTextSchema } from "../shared/schema.js";
import {
  calculateSimilarity,
  searchWeb,
  fetchPageContent,
  nGramSimilarity,
} from "./plagiarism.js";
import multer from "multer";
import WordExtractor from "word-extractor";

const upload = multer({ storage: multer.memoryStorage() });

export function registerRoutes(app) {
  app.post("/api/extract-doc", upload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const extractor = new WordExtractor();
      const extracted = await extractor.extract(req.file.buffer);
      res.json({ text: extracted.getBody() });
    } catch (error) {
      console.error("Doc extraction error:", error);
      res.status(500).json({ error: "Failed to extract doc file" });
    }
  });

  app.post("/api/plagiarism-check", async (req, res) => {
    try {
      const { text } = checkTextSchema.parse(req.body);

      console.log("Starting plagiarism check for text length:", text.length);

      const sentences = text
        .split(/[.!?\n]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 60); // Increased minimum length to 60 for better results and speed

      console.log("Split into", sentences.length, "sentences");

      // Adaptive sampling for very long documents
      let checkEvery = 1;
      if (sentences.length > 300) {
        checkEvery = 3;
      } else if (sentences.length > 100) {
        checkEvery = 2;
      }

      const sentencesToCheck = sentences.filter((_, idx) => idx % checkEvery === 0);
      console.log(`Sampling: checking ${sentencesToCheck.length}/${sentences.length} sentences (every ${checkEvery}th)`);

      const results = [];
      const limit = sentencesToCheck.length;
      
      // Concurrency limit for parallel processing
      const CONCURRENCY = 5; 
      
      // Local cache for URL content during this request
      const urlContentCache = new Map();

      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Transfer-Encoding', 'chunked');

      // Process in batches to avoid overwhelming external APIs
      for (let i = 0; i < limit; i += CONCURRENCY) {
        const batch = sentencesToCheck.slice(i, i + CONCURRENCY);
        
        const batchPromises = batch.map(async (sentence, batchIdx) => {
          const currentIndex = i + batchIdx;
          console.log(`Checking chunk ${currentIndex + 1}/${limit}:`, sentence.substring(0, 50) + "...");

          const urls = await searchWeb(sentence);
          console.log(`Sentence ${currentIndex + 1}: Found ${urls.length} URLs`);

          let maxSimilarity = 0;
          const matchedSources = [];

          // Process URLs for this sentence in parallel
          const urlChecks = urls.map(async (url) => {
            try {
              let content = urlContentCache.get(url);
              if (content === undefined) {
                content = await fetchPageContent(url);
                urlContentCache.set(url, content || "");
              }

              if (content && content.length > 100) {
                const cosineSim = calculateSimilarity(sentence, content);
                const ngramSim = nGramSimilarity(sentence, content, 5);
                const similarity = Math.max(cosineSim, ngramSim);

                if (similarity > 0.15) {
                  return { url, similarity };
                }
              }
            } catch (err) {
              // Ignore individual fetch errors
            }
            return null;
          });

          const urlResults = (await Promise.all(urlChecks)).filter(r => r !== null);
          
          urlResults.forEach(r => {
            if (r.similarity > maxSimilarity) {
              maxSimilarity = r.similarity;
            }
            matchedSources.push({
              url: r.url,
              similarity: Math.round(r.similarity * 100),
            });
          });

          matchedSources.sort((a, b) => b.similarity - a.similarity);

          const result = {
            sentence,
            similarity: Math.round(maxSimilarity * 100),
            sources: matchedSources.slice(0, 5), // Keep top 5 sources
            isPlagiarized: maxSimilarity > 0.4, // Lowered threshold slightly for better detection
          };

          return { index: currentIndex, result };
        });

        const batchResults = await Promise.all(batchPromises);
        
        batchResults.forEach(item => {
          results[item.index] = item.result;
        });

        const progress = Math.round((Math.min(i + CONCURRENCY, limit) / limit) * 100);
        res.write(JSON.stringify({ type: 'progress', progress }) + '\n');
        
        // Small delay between batches to respect rate limits
        if (i + CONCURRENCY < limit) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      const totalSimilarity = results.reduce((sum, r) => sum + (r?.similarity || 0), 0);
      const overallScore = Math.round(totalSimilarity / results.length);
      const plagiarizedCount = results.filter((r) => r?.isPlagiarized).length;
      const plagiarismPercentage = Math.round(
        (plagiarizedCount / results.length) * 100
      );

      console.log("Plagiarism check complete. Overall score:", overallScore);

      const checkResult = {
        overallScore,
        plagiarismPercentage,
        totalSentences: results.length,
        plagiarizedSentences: plagiarizedCount,
        results: results.filter(Boolean),
      };

      res.write(JSON.stringify({ type: 'complete', result: checkResult }) + '\n');
      res.end();
    } catch (error) {
      console.error("Error in plagiarism check:", error);
      if (!res.headersSent) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "An unknown error occurred",
        });
      } else {
        res.write(JSON.stringify({ type: 'error', error: "Internal Server Error" }) + '\n');
        res.end();
      }
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
