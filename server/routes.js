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
        .split(/[.!?]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 20);

      console.log("Split into", sentences.length, "sentences");

      const results = [];
      const limit = sentences.length;

      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Transfer-Encoding', 'chunked');

      for (let i = 0; i < limit; i++) {
        const sentence = sentences[i];
        console.log("Checking chunk:", sentence.substring(0, 50) + "...");

        const urls = await searchWeb(sentence);
        console.log(`Found ${urls.length} URLs to check`);

        let maxSimilarity = 0;
        const matchedSources = [];

        for (const url of urls) {
          const content = await fetchPageContent(url);
          if (content && content.length > 100) {
            const cosineSim = calculateSimilarity(sentence, content);
            const ngramSim = nGramSimilarity(sentence, content, 5);

            const similarity = Math.max(cosineSim, ngramSim);

            console.log(
              `URL ${url}: cosine=${cosineSim.toFixed(2)}, ngram=${ngramSim.toFixed(
                2
              )}, max=${similarity.toFixed(2)}`
            );

            if (similarity > maxSimilarity) {
              maxSimilarity = similarity;
            }

            if (similarity > 0.15) {
              matchedSources.push({
                url,
                similarity: Math.round(similarity * 100),
              });
            }
          }
        }

        matchedSources.sort((a, b) => b.similarity - a.similarity);

        results.push({
          sentence,
          similarity: Math.round(maxSimilarity * 100),
          sources: matchedSources,
          isPlagiarized: maxSimilarity > 0.5,
        });

        res.write(JSON.stringify({ type: 'progress', progress: Math.round(((i + 1) / limit) * 100) }) + '\n');

        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      const totalSimilarity = results.reduce((sum, r) => sum + r.similarity, 0);
      const overallScore = Math.round(totalSimilarity / results.length);
      const plagiarizedCount = results.filter((r) => r.isPlagiarized).length;
      const plagiarismPercentage = Math.round(
        (plagiarizedCount / results.length) * 100
      );

      console.log("Plagiarism check complete. Overall score:", overallScore);

      const checkResult = {
        overallScore,
        plagiarismPercentage,
        totalSentences: results.length,
        plagiarizedSentences: plagiarizedCount,
        results,
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
