import { ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { DuckDuckGoSearch } from "@langchain/community/tools/duckduckgo_search";
import { TavilySearch } from "@langchain/tavily";
import { WikipediaQueryRun } from "@langchain/community/tools/wikipedia_query_run";
import { Pinecone } from "@pinecone-database/pinecone";

// import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { createAgent, tool } from "langchain";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import * as z from "zod";
import * as fs from "fs";
import dotenv from "dotenv";
dotenv.config();


// Initialize a Pinecone client with your API key
const pc = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY,
});
// Create a dense index with integrated embedding
const indexName = "policy-data-index";
// Target the index
const index = pc.index(indexName).namespace("policy-data-namespace");

//load pdf file
async function loadSinglePDF(filepath) {
  console.log(`Loading PDF: ${filepath}`);
  
  if (!fs.existsSync(filepath)) {
    throw new Error(`PDF file not found: ${filepath}`);
  }
  
  const loader = new PDFLoader(filepath);
  const docs = await loader.load();
  
  console.log(`Loaded PDF with ${docs.length} pages`);
  return docs;
}

const webSearchTool = new TavilySearch({
  maxResults: 5,
  apiKey: process.env.TAVILY_API_KEY,
  description: "Search the web for industry benchmarks, trends, regulatory updates, and current information. Use this for queries about hiring trends, compliance regulations, market data, and industry news."
});

const wikiTool = new WikipediaQueryRun({
  topKResults: 3,
  maxDocContentLength: 4000,
  description: "Search Wikipedia for general knowledge and established concepts"
});

const getWeather = tool(
  ({ location }) => `Weather in ${location}: Sunny, 72°F`,
  {
    name: "get_weather",
    description: "Get weather information for a location",
    schema: z.object({
      location: z.string().describe("The location to get weather for"),
    }),
  }
);

const getAqi = tool(
  ({ location }) => `AQI in ${location}: 42 (Good)`,
  {
    name: "get_aqi",
    description: "Get air quality index for a location",
    schema: z.object({
      location: z.string().describe("The location to get AQI for"),
    }),
  }
);

const rag_tool= tool(
    async ({ question }) => {
        const result= await index.searchRecords({
        query: {
          topK: 5,
          inputs: { text: question }
        }
      });
      console.log("RAG Search Results:", result);
      const pineconeContext = result.result.hits
        .map(h => h.fields.chunk_text)
        .join("\n");
      return `Context:\n${pineconeContext}`;
    },
    {
        name: "rag_tool",
        description: "Retrieve information from the company policy/HR policy data knowledge base for the company Suna Pana. Use this to answer questions about company policies, HR guidelines, benefits, leave policies, and workplace conduct.",
        schema: z.object({
          question: z.string().describe("The question to retrieve information for"),
        }),
    }

)



const add_data_to_rag= async() =>{
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
      return;
    }
    
    
    // Load documents from PDF
    const docs = await loadSinglePDF('pdfs/company_data.pdf');
    const full_document=docs.map(doc=>doc.pageContent).join("\n");
    console.log("Loaded Documents:", full_document);

    
    // Split into dynamic chunks
    const chunks = dynamicChunk(full_document, 80, 20);

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
    

}

//Adding data to RAG index, skips if the index already exists(for one time flow only to add information to vector db from pdf)
await add_data_to_rag();


//model creation and agent creation
const model = new ChatGoogleGenerativeAI({
  model: "gemini-2.5-flash-lite",
  apiKey: process.env.GEMINI_API_KEY,
});

const agent = createAgent({
  model: model,
  tools: [getWeather,getAqi, wikiTool,webSearchTool, rag_tool],
});


const response = await agent.invoke({
  messages: [{ role: "user", content: "what is the leave policy in suna pana company?" }]
});
console.log("Full Response:", response);
const finalMessage = response.messages[response.messages.length - 1];
console.log("Answer:", finalMessage.content);








