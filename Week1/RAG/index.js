// Import the Pinecone library
import { Pinecone } from "@pinecone-database/pinecone";
import ollama from "ollama";
import readline from "node:readline";
import dotenv from "dotenv";
import fs from "fs";
dotenv.config();


function dynamicChunk(text, maxChars, overlap) {
  text = text.replace(/\s+/g, " ").trim();

  // Split by sentence boundaries
  const sentences = text.split(/(?<=[.!?])\s+/);

  const chunks = [];
  let buffer = "";

  for (const s of sentences) {
    if ((buffer + s).length <= maxChars) {
      buffer += " " + s;
    } else {
      chunks.push(buffer.trim());
      buffer = buffer.slice(-overlap) + " " + s;
    }
  }

  if (buffer.trim()) chunks.push(buffer.trim());

  return chunks;
}





// Initialize a Pinecone client with your API key
const pc = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY,
});

// Create a dense index with integrated embedding
const indexName = "facts-index";

const existingIndexes = await pc.listIndexes();

if (!existingIndexes.indexes.some((i) => i.name === indexName)) {
  console.log("Creating Pinecone index...");
  await pc.createIndexForModel({
    name: indexName,
    cloud: "aws",
    region: "us-east-1",
    embed: {
      model: "llama-text-embed-v2",
      fieldMap: { text: "chunk_text" },
    },
    waitUntilReady: true,
  });
} else {
  console.log("Index already exists, skipping creation.");
}

// Sample records to upsert

// Target the index
const index = pc.index(indexName).namespace("facts-namespace");

// Read from text file
const data = fs.readFileSync("sample_data.txt", "utf-8");

// Split into dynamic chunks
const chunks = dynamicChunk(data, 80, 20);

// Prepare records for upsert
const records = chunks
  .map(c => c.trim())
  .filter(c => c.length > 0)
  .map((chunk, idx) => ({
    _id: `fact-${idx}`,
    chunk_text: chunk
  }));






// Upsert the records into a namespace
await index.upsertRecords(records);

// // Wait for the upserted vectors to be indexed
// await new Promise((resolve) => setTimeout(resolve, 10000));

// View stats for the index
const stats = await index.describeIndexStats();
console.log(stats);

async function askOllama() {
  const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Conversation memory
let chatHistory = "";

console.log("\nRAG Chatbot (Pinecone + Ollama)");
console.log("Type 'exit' to quit\n");

async function chatLoop() {
  rl.question("You: ", async (query) => {
    if (query.toLowerCase() === "exit") {
      console.log("Goodbye 👋");
      rl.close();
      return;
    }

    try {
      // 1️⃣ Search Pinecone
      const result = await index.searchRecords({
        query: {
          topK: 5,
          inputs: { text: query }
        }
      });

      const pineconeContext = result.result.hits
        .map(h => h.fields.chunk_text)
        .join("\n");

      // 2️⃣ Combine memory + retrieved knowledge
      const fullContext = `
        Previous conversation:
        ${chatHistory}

        Knowledge base:
        ${pineconeContext}
        `;

              const prompt = `
        Use the following context to answer the question.
        If the answer is not in the context then try to give a relevant answer based on your knowledge, if you do not have any answer then say that "Its out of my knowledge base".

        ${fullContext}

        Question:
        ${query}
        `;

      const response = await ollama.chat({
        model: "gemma3",
        messages: [{ role: "user", content: prompt }]
      });

      const answer = response.message.content;

      console.log("\n🤖:", answer);

      // 3️⃣ Store in memory
      chatHistory += `\nUser: ${query}\nAI: ${answer}\n`;

    } catch (err) {
      console.error("Error:", err.message);
    }

    console.log("\n----------------------------\n");
    chatLoop();
  });
}

chatLoop();
}

await askOllama();
